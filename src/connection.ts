import WebSocket from "ws";
import Room from './room';
import { Events } from './events';
import { Buffer } from 'buffer';

export default class Connection {
    socket: WebSocket;
    id?: string;
    playerId?: number;
    clientId?: number;
    room?: Room;
    isAlive: boolean;

    constructor(socket: WebSocket) {
        this.socket = socket;
    }

    join(room: Room, playerId: number) {
        this.room = room;
        this.playerId = playerId;

        this.room.add(this);

        this.room.broadcast((c: Connection) => c.id !== this.id, Events.Join, this.id, this.playerId);

        this.send(Events.SetClients, room.clients((c: Connection) => c.id !== this.id));
    }

    leave() {
        this.room.remove(this);
        this.room = null;
    }

    setId(id: number, clientId: number) {
        this.playerId = id;
        this.clientId = clientId;

        if (this.room) {
            this.room.broadcast((c: Connection) => c.id !== this.id, Events.SetClient, {
                id: this.playerId,
                clientId: this.clientId
            });
        }
    }

    send(event: Events, ...data: any[]) {
        let dataBuf: null|Buffer = null;

        if (data.length > 0) {
            if (data[0] instanceof Object) {
                data = data[0];
            }

            dataBuf = Buffer.from(JSON.stringify(data));
        }

        let buf = Buffer.alloc(3);

        buf.writeUInt8(event, 0);
        buf.writeUInt16BE(dataBuf ? dataBuf.byteLength : 0, 1);
        console.log(buf.toString('hex'));

        if (dataBuf) {
            console.log('Data:', dataBuf.toString());
            buf = Buffer.concat([ buf, dataBuf ]);
        }


        return this.socket.send(buf);
    }
}