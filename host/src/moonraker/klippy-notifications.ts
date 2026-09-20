import type {KlippySnapshot} from './klippy-lifecycle.ts';
export type KlippyNotification='notify_klippy_ready'|'notify_klippy_shutdown'|'notify_klippy_disconnected';
/** Notification state for one connection generation. Ready belongs to completed
 * initialization; status updates only emit transitions into shutdown. */
export class KlippyNotifications {
 #connected=false;#initialized=false;#state:KlippySnapshot['state']='disconnected';
 observe(snapshot:Pick<KlippySnapshot,'connected'|'initialized'|'state'>):KlippyNotification[]{
  const events:KlippyNotification[]=[];
  if(this.#connected&&!snapshot.connected)events.push('notify_klippy_disconnected');
  if(snapshot.connected&&snapshot.initialized){if(!this.#initialized&&snapshot.state==='ready')events.push('notify_klippy_ready');else if(this.#initialized&&snapshot.state==='shutdown'&&this.#state!=='shutdown')events.push('notify_klippy_shutdown');}
  this.#connected=snapshot.connected;this.#initialized=snapshot.connected&&snapshot.initialized;this.#state=snapshot.state;return events;
 }
}
