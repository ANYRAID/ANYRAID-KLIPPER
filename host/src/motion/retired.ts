/** Expected cancellation of a motion generation that has been fenced by its
 * owner. It is not proof of MCU stop, execution, or acknowledgement. */
export class MotionRetiredError extends Error {
 constructor(){super('Motion transport retired');this.name='MotionRetiredError';}
}
