import { randomUUID, getRandomValues } from 'crypto';
import { Socket, createServer } from 'net';

class Room {
    /**
     * @type {{[key: string]: Room}}
     */
    static rooms = {};

    /**
     * @param {Client} master 
     */
    constructor(master, maxClientCount = 0) {
        do {
            this.uid = Array(5).fill(0)
                .map(_ => Math.floor(Math.random() * 36).toString(36))
                .join('').toUpperCase()
        }
        while(Room.rooms[this.uid]);
        /**
         * @type {Client[]}
         */
        this.clients = [];
        this.maxClientCount = maxClientCount;
        /**
         * @type {{[key: string]: string}}
         */
        this.roomState = {};

        Room.rooms[this.uid] = this;
        master.joinRoom(this.uid);

        console.log('new room created : ' + this.uid);
    }

    /**
     * 
     * @param {string} key 
     * @param {string} value 
     */
    setRoomState(key, value) {
        roomState[key] = value;
    }

    removeRoom() {
        this.clients.forEach(c => c.leaveRoom());
        console.log('room removed : ' + this.uid);
        delete Room.rooms[this.uid];
    }

    /**
     * @param {Client} client 
     */
    leaveClient(client) {
        let idx = this.clients.findIndex(c => c === client);
        if(idx !== -1) this.clients.splice(idx, 1);
        client.roomId = null;
        this.clients.concat([client]).forEach(c => {
            c.sendPing();
            c.sendPacket('server', 'leave-client', client.uid);
        });
        if(this.clients.length === 0) {
            this.removeRoom();
        }
    }

    /**
     * @param {Client} client 
     */
    joinClient(client) {
        let idx = this.clients.findIndex(c => c === client);
        if(((this.maxClientCount <= this.clients.length) && this.maxClientCount > 0) || idx !== -1) return false;

        this.clients.push(client);
        client.roomId = this.uid;
        this.clients[0].sendPing();
        this.clients.forEach(c => {
            c.sendPing();
            c.sendPacket('server', 'join-client', client.uid);
        });

        return true;
    }

    /**
     * @param {Client} client 
     */
    isMaster(client) {
        return client === this.clients[0];
    }
}

class Client {
    /**
     * @type {{[key: string]: Client}}
     */
    static clients = {};
    /**
     * @param {Socket} socket 
     */
    constructor(socket) {
        this.socket = socket;
        do {
            this.uid = randomUUID().toString();
        }
        while(Client.clients[this.uid]);
        /**
         * @type {null | string}
         */
        this.roomId = null;
        this.latestPing = Date.now();
        this.ping = 0;
        this.nickname = "Unnamed";
        Client.clients[this.uid] = this;
    }

    /**
     * @param {string} from 
     * @param {string} event 
     * @param {string} message 
     */
    sendPacket(from, event, message) {
        this.socket.write(`${from}:${event}:${message}\0`);
    }

    getRoom() {
        if(!this.roomId) return null;
        return Room.rooms[this.roomId] ?? null;
    }

    /**
     * @param {string} roomId 
     */
    joinRoom(roomId) {
        return Room.rooms[roomId]?.joinClient?.(this) ?? false;
    }

    isMasterClient() {
        return this.roomId !== null && (Room.rooms[this.roomId]?.isMaster(this) ?? false);
    }

    leaveRoom() {
        if(this.roomId)
            Room.rooms[this.roomId]?.leaveClient?.(this);
    }

    onDisconnect() {
        this.leaveRoom();
        delete Client.clients[this.uid];
    } 

    get clientInfo() {
        return ({
            uid: this.uid,
            ping: this.ping,
            nickname: this.nickname
        });
    }

    createPingPacket() {
        return JSON.stringify({
            'ping': this.ping,
            'uid': this.uid,
            'room_id': this.roomId,
            'nickname': this.nickname,
            'max_client_count': this.getRoom()?.maxClientCount ?? 0,
            'clients': this.getRoom()?.clients?.map?.(c => c.clientInfo) ?? [],
            'is_master_client': this.isMasterClient(),
            'room_state': this.getRoom()?.roomState ?? {}
        });
    }

    sendPing() {
        this.latestPing = Date.now();
        this.sendPacket('server', 'ping', this.createPingPacket());
    }
}

/**
 * process the received packet data
 * @param {Client} client
 * @param {string} packet 
 */
function processPacket(client, packet) {
    const args = packet.split(':');
    const target = args[0] ?? 'server';
    const event = args[1] ?? '';
    const message = args.slice(2).join(':');
    
    console.log(packet);

    let room = client.getRoom();

    switch(target) {
        case 'server':
            switch(event) {
                case 'pong':
                    client.ping = Date.now() - client.latestPing;
                    break;
                case 'create-room':
                    if(!room) {
                        new Room(client, 0);
                        room = client.getRoom();
                        client.sendPing();
                    }
                    break;
                case 'join-room': {
                    let targetRoom = Room.rooms[message];
                    if(!targetRoom) client.sendPacket('server', 'join-room-failed', 'invalid-room-id');
                    else if(room) client.sendPacket('server', 'join-room-failed', 'already-in-room');
                    else {
                        let result = client.joinRoom(message);
                        if(!result) client.sendPacket('server', 'join-room-failed', 'full-room');
                        else {
                            client.sendPing();
                            room = client.getRoom();
                        }
                    }
                    break;
                }
                case 'leave-room': 
                    client.leaveRoom();
                    room = client.getRoom();
                    break;
                case 'set-room-state':
                    if(room && client.isMasterClient()) {
                        let entry = message.split(':')
                        room.roomState[entry[0]] = entry.slice(1).join(':');
                        room.clients.forEach(c => c.sendPing());
                    }
                    break;
                case 'remove-room-state':
                    if(room && client.isMasterClient()) {
                        delete room.roomState[message];
                        room.clients.forEach(c => c.sendPing());
                    }
                    break;
                case 'kick-player':
                    if(room && client.isMasterClient()) {
                        let target = room.clients.find(c => c.uid === message);
                        if(target) room.leaveClient(target);
                    }
                    break;
                case 'change-nickname': {
                    let nickname = message.slice(0, 15).trim();
                    if(nickname.length === 0) nickname = "(empty)";
                    client.nickname = nickname;
                    break;
                }
            }
            break;
        case 'all':
            if(room) room.clients.forEach(c => c.sendPacket(client.uid, event, message));
            else client.sendPacket(client.uid, event, message);
            break;
        case 'others':
            if(room) room.clients.forEach(c => {
                if(c !== client) c.sendPacket(client.uid, event, message);
            });
            break;
        case 'master':
            if(room) room.clients[0]?.sendPacket?.(client.uid, event, message);
            else client.sendPacket(client.uid, event, message);
            break;
        default:
            if(room) room.clients.find(c => c.uid === target)?.sendPacket?.(client.uid, event, message);
    }
}

const server = createServer(socket => {
    console.log(socket.address().address + ' connected!');

    const client = new Client(socket);

    let buffer = '';
    socket.on('data', data => {
        buffer += data.toString();
        const packets = buffer.split('\0');

        buffer = packets.pop();

        packets.forEach(packet => {
            processPacket(client, packet);
        });
    });

    const task = setInterval(() => {
        client.sendPing();
    }, 1000);

    socket.on('close', () => {
        console.log('client disconnected');
        clearInterval(task);
        client.onDisconnect();
    });

    socket.on('error', err => {
        if(err.code === 'ECONNRESET') return;
        console.error(err);
    });
});

server.on('error', err => {
    if(err.code === 'ECONNRESET') return;
    console.error(err);
});

server.listen(7777, () => {
    console.log('server is running on 7777');
});