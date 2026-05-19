// SwipeCard — attaches drag/touch gestures to a card element.
// Calls callbacks.onRight / onLeft / onUp when the user releases past the threshold.

export class SwipeCard {
  constructor(element, callbacks = {}) {
    this.el = element;
    this.cb = callbacks;
    this.active = false;
    this.startX = 0;
    this.startY = 0;
    this.dx = 0;
    this.dy = 0;
    this._onStart = this._onStart.bind(this);
    this._onMove  = this._onMove.bind(this);
    this._onEnd   = this._onEnd.bind(this);
    this.el.addEventListener('pointerdown', this._onStart);
  }

  _onStart(e) {
    // Only respond to the primary pointer (finger or left-click)
    if (e.button !== undefined && e.button !== 0) return;
    this.active = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.dx = 0;
    this.dy = 0;
    this.el.setPointerCapture(e.pointerId);
    this.el.classList.add('dragging');
    this.el.style.transition = 'none';
    this.el.addEventListener('pointermove', this._onMove);
    this.el.addEventListener('pointerup',   this._onEnd);
    this.el.addEventListener('pointercancel', this._onEnd);
  }

  _onMove(e) {
    if (!this.active) return;
    this.dx = e.clientX - this.startX;
    this.dy = e.clientY - this.startY;

    const rotation = this.dx * 0.06;
    this.el.style.transform = `translate(${this.dx}px, ${this.dy}px) rotate(${rotation}deg)`;

    // Show direction overlay
    const absDx = Math.abs(this.dx);
    const threshold = 50;
    this.el.classList.toggle('swiping-right', this.dx > threshold);
    this.el.classList.toggle('swiping-left',  this.dx < -threshold);
    this.el.classList.toggle('swiping-up',    this.dy < -threshold && absDx < 80);

    // Notify parent to update directional labels
    this.cb.onDrag?.({ dx: this.dx, dy: this.dy });
  }

  _onEnd(e) {
    if (!this.active) return;
    this.active = false;
    this.el.removeEventListener('pointermove', this._onMove);
    this.el.removeEventListener('pointerup',   this._onEnd);
    this.el.removeEventListener('pointercancel', this._onEnd);
    this.el.classList.remove('dragging');

    const X_THRESHOLD = 100;
    const Y_THRESHOLD = 80;

    if (this.dx > X_THRESHOLD) {
      this._flyOut('right');
    } else if (this.dx < -X_THRESHOLD) {
      this._flyOut('left');
    } else if (this.dy < -Y_THRESHOLD && Math.abs(this.dx) < 90) {
      this._flyOut('up');
    } else {
      // Snap back
      this.el.style.transition = '';
      this.el.style.transform = '';
      this.el.classList.remove('swiping-right', 'swiping-left', 'swiping-up');
      this.cb.onDrag?.({ dx: 0, dy: 0 });
    }
  }

  _flyOut(direction) {
    this.el.classList.remove('swiping-right', 'swiping-left', 'swiping-up');
    this.el.classList.add(`fly-${direction}`);
    this.el.style.transition = '';
    this.el.style.transform  = '';

    // Wait for animation, then call callback
    const handler = () => {
      this.el.removeEventListener('animationend', handler);
      if (direction === 'right') this.cb.onRight?.();
      else if (direction === 'left') this.cb.onLeft?.();
      else if (direction === 'up') this.cb.onUp?.();
    };
    this.el.addEventListener('animationend', handler);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this._onStart);
    this.el.removeEventListener('pointermove', this._onMove);
    this.el.removeEventListener('pointerup',   this._onEnd);
    this.el.removeEventListener('pointercancel', this._onEnd);
  }
}
