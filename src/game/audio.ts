export class AudioEngine {
  private context: AudioContext | null = null;
  private enabled = true;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
    }
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  playTurn(): void {
    this.playTone(260, 0.045, "triangle", 0.055);
    window.setTimeout(() => this.playTone(390, 0.03, "sine", 0.035), 45);
  }

  playSoft(): void {
    this.playTone(520, 0.055, "sine", 0.035);
  }

  playWin(): void {
    [392, 494, 587, 784].forEach((frequency, index) => {
      window.setTimeout(() => this.playTone(frequency, 0.11, "sine", 0.05), index * 85);
    });
  }

  playError(): void {
    this.playTone(130, 0.08, "sawtooth", 0.035);
  }

  private playTone(frequency: number, duration: number, type: OscillatorType, gainValue: number): void {
    if (!this.enabled || !this.context) return;

    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(gainValue, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.03);
  }
}
