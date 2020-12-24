import express from 'express';
import { Server } from 'http';
import { Server as HttpsServer } from 'https';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import Tracer from 'tracer';
import morgan from 'morgan';
import publicIp from 'public-ip';
import WebSocket from 'ws';
import Room from './room';
import Connection from './connection';
import { Events } from './events';
import SnowflakeId from 'snowflake-id';

const httpsEnabled = !!process.env.HTTPS;

const port = parseInt(process.env.PORT || (httpsEnabled ? '443' : '9736'));

const sslCertificatePath = process.env.SSLPATH || process.cwd();
const supportedVersions = readdirSync(join(process.cwd(), 'offsets')).map(file => file.replace('.yml', ''));

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
	server,
	perMessageDeflate: {
		zlibDeflateOptions: {
			// See zlib defaults.
			chunkSize: 1024,
			memLevel: 7,
			level: 3
		},
		zlibInflateOptions: {
			chunkSize: 10 * 1024
		},
		// Other options settable:
		clientNoContextTakeover: true, // Defaults to negotiated value.
		serverNoContextTakeover: true, // Defaults to negotiated value.
		serverMaxWindowBits: 10, // Defaults to negotiated value.
		// Below options specified as default values.
		concurrencyLimit: 10, // Limits zlib concurrency for perf.
		threshold: 1024 // Size (in bytes) below which messages
		// should not be compressed.
	}
});

const snowflake = new SnowflakeId({
	mid : 42,
	offset : (2019-1970)*31536000*1000
});

app.set('view engine', 'pug')
app.use(morgan('combined'))
app.use(express.static('offsets'))
let connectionCount = 0;
let address = process.env.ADDRESS;

app.get('/', (_, res) => {
	res.render('index', { connectionCount, address });
});

app.get('/health', (req, res) => {
	res.json({
		uptime: process.uptime(),
		connectionCount,
		address,
		name: process.env.NAME,
		supportedVersions
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
		// TODO: Check version

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

	socket.on('join', (c: string, id: number) => {
		if (!connection) {
			socket.terminate();
			return;
		}

		code = c;

		let room = rooms.get(c);

		if (!room) {
			rooms.set(c, room = new Room(c));
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
	if (!address)
		address = `http://${await publicIp.v4()}:${port}`;
	logger.info('CrewLink Server started: %s', address);
})();