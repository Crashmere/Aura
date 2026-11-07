type Direction = -1 | 1;
type Impulse = { x: number; y: number; magnitude: number; direction: Direction };

export class TrackpadSwipe {
  private x = 0;
  private y = 0;
  private locked = false;
  private direction: Direction = 1;
  private peak = 0;
  private previous = 0;
  private slowed = false;
  private tailMinimum = Infinity;
  private impulse: Impulse | null = null;

  consume(deltaX: number, deltaY: number): Direction | 0 {
    const magnitude = Math.abs(deltaX);
    if (magnitude <= Math.abs(deltaY) * 1.3) {
      this.impulse = null;
      if (!this.locked) this.x = this.y = 0;
      return 0;
    }
    const direction: Direction = deltaX > 0 ? 1 : -1;
    if (this.locked) {
      this.slowed ||= magnitude <= this.peak * 0.4;
      if (this.slowed) this.tailMinimum = Math.min(this.tailMinimum, magnitude);
      const previous = this.previous;
      this.previous = magnitude;
      this.peak = Math.max(this.peak, magnitude);
      if (this.impulse) {
        const impulse = this.impulse;
        this.impulse = null;
        // Require a second strong sample so one irregular momentum delta cannot unlock.
        if (direction !== impulse.direction || magnitude < impulse.magnitude * 0.85) return 0;
        this.locked = false;
        this.slowed = false;
        this.tailMinimum = Infinity;
        this.x = impulse.x;
        this.y = impulse.y;
        this.peak = Math.max(impulse.magnitude, magnitude);
      } else {
        const renewed = this.slowed && magnitude > previous && magnitude - this.tailMinimum >= 4;
        if (magnitude >= 8 && (direction !== this.direction || renewed)) {
          this.impulse = { x: deltaX, y: Math.abs(deltaY), magnitude, direction };
        }
        return 0;
      }
    }
    if (this.x * deltaX < 0) this.x = this.y = 0;
    this.previous = magnitude;
    this.peak = Math.max(this.peak, magnitude);
    this.x += deltaX;
    this.y += Math.abs(deltaY);
    if (Math.abs(this.x) < 80 || Math.abs(this.x) <= this.y * 1.3) return 0;
    this.direction = this.x > 0 ? 1 : -1;
    // WheelEvent has no finger-release phase; latch the stroke through its inertial tail.
    this.locked = true;
    this.slowed = false;
    this.tailMinimum = Infinity;
    this.x = this.y = 0;
    return this.direction;
  }
}
