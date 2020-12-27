import express from 'express';
import { Server, IncomingMessage } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import Tracer from 'tracer';
import morgan from 'morgan';
import WebSocket from 'ws';
import Room from './room';
import Connection from './connection';
import { Events } from './events';
import SnowflakeId from 'snowflake-id';
import { Socket } from 'net';

const supportedCrewLinkVersions = new Set(['1.2.0']);
const httpsEnabled = !!process.env.HTTPS;

const port = process.env.PORT || (httpsEnabled ? '443' : '9736');

const sslCertificatePath = process.env.SSLPATH || process.cwd();

const logger = Tracer.colorConsole({
	format: "{{timestamp}} <{{title}}> {{message}}"
});

const app = express();
let server: HttpsServer | Server;
if (httpsEnabled) {
	server = new HttpsServer({
		key: readFileSync(join(sslCertificatePath, 'privkey.pem')),
		cert: readFileSync(join(sslCertificatePath, 'fullchain.pem'))
	}, app);
} else {
	server = new Server(app);
}

const wss = new WebSocket.Server({
	noServer: true,
	perMessageDeflate: {
		zlibDeflateOptions: {
			chunkSize: 1024,
			memLevel: 7,
			level: 3
		},
		zlibInflateOptions: {
			chunkSize: 10 * 1024
		},
		clientNoContextTakeover: true,
		serverNoContextTakeover: true,
		serverMaxWindowBits: 10,
		concurrencyLimit: 10,
		threshold: 1024
	}
});

server.on('upgrade', (request: IncomingMessage, socket: Socket, head: Buffer)  => {
	const userAgent = request.headers['user-agent'];
	const matches = /^CrewLink\/(\d+\.\d+\.\d+) \((\w+)\)$/.exec(userAgent);
	const error = 'The voice server does not support your version of CrewLink.\nSupported versions: ' + Array.from(supportedCrewLinkVersions).join();
	if (!matches) {
		wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
			ws.close(4000, error);
		});
	} else {
		const version = matches[1];
		// const platform = matches[2];
		if (supportedCrewLinkVersions.has(version)) {
			wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				wss.emit('connection', ws);
			});
		} else {
			wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
				ws.close(4000, error);
			});
		}
	}
});

const snowflake = new SnowflakeId({
	mid : 42,
	offset : (2019-1970)*31536000*1000
});

app.set('view engine', 'pug')
app.use(morgan('combined'))

let connectionCount = 0;
let address = process.env.ADDRESS;
if (!address) {
	logger.error('You must set the ADDRESS environment variable.');
	process.exit(1);
}

app.get('/', (_, res) => {
	res.render('index', { connectionCount, address });
});

app.get('/health', (req, res) => {
	res.json({
		uptime: process.uptime(),
		connectionCount,
		address,
		name: process.env.NAME
	});
})

const rooms = new Map<string, Room>();
const connections: Connection[] = [];

wss.on('connection', (socket: WebSocket) => {
	connectionCount++;
	logger.info("Total connected: %d", connectionCount);
	let code: string | null = null;

	let connectTimeout = setTimeout(() => socket.terminate(), 5000);

	let connection: Connection;

	socket.on('message', function(buf: Buffer) {
		if (buf.length < 3) {
			socket.terminate();
			return;
		}

		let type = buf.readUInt8(0);
		let len = buf.readUInt16BE(1);

		let data: any = null;

		if (len > 0) {
			data = JSON.parse(buf.toString('utf8', 3, 3+len));
		}

		switch (type) {
			case Events.Authentication:
				if (!data) {
					socket.terminate();
					return;
				}

				socket.emit('authenticate', data);
				break;
			case Events.Join:
				if (data?.length < 3) {
					socket.terminate();
					return;
				}

				// [lobbyCode, id]
				socket.emit('join', data[0], data[1], data[2]);
				break;
			case Events.Leave:
				socket.emit('leave');
				break;
			case Events.SetClient:
				if (data?.length < 2) {
					socket.terminate();
					return;
				}

				socket.emit('client', data[0], data[1]);
				break;
			case Events.Signal:
				if (data?.length < 2) {
					socket.terminate();
					return;
				}

				// [peer, data]
				socket.emit('signal', data[0], data[1]);
				break;
			default:
				socket.terminate();
				console.log('Unknown event', type);
		}
	});

	socket.on('authenticate', (data: any) => {
		// Reset connect authentication timeout
		clearTimeout(connectTimeout);

		const id = snowflake.generate();

		connection = new Connection(socket);
		connection.id = id;
		connections.push(connection);

		connection.send(Events.Authentication, {
			'id': id
		});
	});

	socket.on('join', (c: string, id: number, clientId: number) => {
		if (!connection) {
			socket.terminate();
			return;
		}

		code = c;

		let room = rooms.get(c);

		if (!room) {
			rooms.set(c, room = new Room(c));
		}

		for (let s of room.connections) {
			if (s.clientId !== null && s.clientId === clientId) {
				socket.terminate();
				logger.error(`Socket %s sent invalid join command, attempted spoofing another client`);
				return;
			}
		}

		connection.join(room, id);
	});

	socket.on('leave', () => {
		if (!connection || !connection.room) {
			return;
		}

		let room = connection.room;

		// Leave room
		connection.leave();

		if (room.count() < 1) {
			rooms.delete(room.code);
		}
	});

	socket.on('client', (id: number, clientId: number) => {
		if (!connection) {
			return;
		}

		if (connection.clientId != null && connection.clientId !== clientId) {
			socket.terminate();
			logger.error(`Socket %s sent invalid id command, attempted spoofing another client`);
			return;
		}

		connection.setId(id, clientId);
	});

	socket.on('signal', (peer: string, data: string) => {
		if (!connection) {
			return;
		}

		let peerConnection = connection.room.find(peer);

		if (peerConnection != null) {
			peerConnection.send(Events.Signal, connection.id, data);
		}
	});

	socket.on('close', () => {
		connectionCount--;

		logger.info("Total connected: %d", connectionCount);

		if (!connection) {
			return;
		}

		let room = connection.room;

		connection.leave();

		if (room.count() < 1) {
			rooms.delete(room.code);
		}

		const index = connections.indexOf(connection);

		if (index > -1) {
			connections.splice(index, 1);
		}
	});

	socket.on('pong', () => {
		connection.isAlive = true;
	});
});

function noop() {

}

const interval = setInterval(function ping() {
	connections.forEach((c: Connection) => {
		if (c.isAlive === false) {
			return c.socket.terminate();
		}

		c.isAlive = false;
		c.socket.ping(noop);
	});
}, 30000);

wss.on('close', function close() {
	clearInterval(interval);
});

server.listen(port);
(async () => {
	logger.info('CrewLink Server started: %s', address);
})();