import { WebSocket as Socket } from 'ws';
import { createPhoneReceiver } from '../../public/transport/phone-receiver.js';

// Tests consume logical messages using the browser's production assembler.
export class WebSocket extends Socket {
  constructor(...args) {
    super(...args);
    this.receiver = createPhoneReceiver({
      send: value => this.send(JSON.stringify(value)),
      receive: value => super.emit('message', Buffer.from(JSON.stringify(value)), false)
    });
  }
  emit(event, ...args) {
    if (event === 'message' && this.receiver) {
      const message = JSON.parse(args[0]);
      if (message.type?.startsWith('transport:')) {
        try { this.receiver.accept(message); } catch (error) { super.emit('error', error); }
        return true;
      }
    }
    return super.emit(event, ...args);
  }
}
