import Connection from './connection';
import { Events } from './events';

export default class Room {
    code: string;
    playerId?: number;
    connections: Connection[];

    constructor(code: string) {
        this.code = code;
        this.connections = [];
    }

    broadcast(test: (c: Connection) => boolean, event: Events, ...args: any[]) {
        this.connections.filter(test).forEach((s: Connection) => s.send(event, ...args))
    }

    count(): number {
        return this.connections.length;
    }

    find(id: string): Connection {
        return this.connections.find((s: Connection) => s.id == id);
    }

    add(connection: Connection) {
        this.connections.push(connection);
    }

    remove(connection: Connection) {
        const index = this.connections.indexOf(connection);

        if (index > -1) {
            this.connections.splice(index, 1);
        }
    }

    clients(test: (c: Connection) => boolean) {
        let ids: any = {};

        this.connections.filter(test).forEach((s: Connection) => {
            if (s.playerId) {
                ids[s.id] = {
                    id: s.playerId,
                    clientId: s.clientId
                };
            }
        });

        return ids;
    }
}