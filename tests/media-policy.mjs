import assert from 'node:assert/strict';
import { associateMedia, configureReceiver } from '../media-policy.js';

globalThis.MediaStream = class { constructor() { this.id = Math.random().toString(36); } };
const slots = ['audio', 'video', 'audio', 'video'].map(kind => ({ receiver: { track: { kind }, jitterBufferTarget: 160 }, sender: { setStreams(stream) { this.stream = stream; } } })), peer = { slots };
associateMedia(peer);
assert.deepEqual(slots.map(slot => slot.receiver.jitterBufferTarget), [160, 160, 160, 160]);
assert.equal(slots[1].sender.stream, slots[2].sender.stream);
assert.notEqual(slots[0].sender.stream, slots[2].sender.stream);
assert.notEqual(slots[3].sender.stream, slots[2].sender.stream);
const streams = [...peer.mediaStreams]; associateMedia(peer); assert.deepEqual(peer.mediaStreams, streams);
console.log('PASS associating adopted streams preserves receiver jitter settings and screen audio/video synchronization');
for (const [mode, expected] of [['stable', [160, 160]], ['balanced', [80, 80]], ['low', [20, 40]]]) { const receivers = [{ jitterBufferTarget: 0 }, { jitterBufferTarget: 0 }]; receivers.forEach((receiver, index) => configureReceiver(receiver, index, mode)); assert.deepEqual(receivers.map(receiver => receiver.jitterBufferTarget), expected); }
configureReceiver({ set jitterBufferTarget(_) { throw Error('Unsupported'); } }, 0, 'stable');
console.log('PASS requested jitter modes apply while unsupported browser controls remain optional');
