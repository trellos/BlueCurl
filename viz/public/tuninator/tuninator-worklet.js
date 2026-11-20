"use strict";
(() => {
  // src/engine/kernels/channel-select.ts
  var DEFAULT_WINDOW_MS = 250;
  var DEFAULT_MARGIN_DB = 6;
  var DEFAULT_SUSTAIN_WINDOWS = 3;
  var DEFAULT_SILENCE_RMS = 8e-3;
  var ChannelSelector = class {
    channelCount;
    windowMs;
    sustainWindows;
    silenceRms;
    /** `marginDb` pre-converted to an amplitude ratio. */
    marginRatio;
    /** Accumulated sum of `rms^2 * ms` for the window in progress. */
    energy;
    windowElapsedMs = 0;
    /** Latched selection, or -1 while no window has ever carried real signal. */
    selectedIndex = -1;
    /** Channel currently mounting a challenge, and how many windows it has won. */
    challenger = -1;
    challengerStreak = 0;
    /** Windows evaluated (i.e. not discarded as silent). Diagnostics only. */
    decisionCount = 0;
    constructor(config) {
      this.channelCount = Math.max(1, Math.floor(config.channelCount));
      this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
      this.sustainWindows = Math.max(1, config.sustainWindows ?? DEFAULT_SUSTAIN_WINDOWS);
      this.silenceRms = config.silenceRms ?? DEFAULT_SILENCE_RMS;
      this.marginRatio = dbToRatio(config.marginDb ?? DEFAULT_MARGIN_DB);
      this.energy = new Array(this.channelCount).fill(0);
    }
    /**
     * The channel to analyse, or `null` when no decision has been latched yet.
     *
     * Mono answers 0 immediately: with one channel the "selection" is not a
     * decision, and making the caller wait for a window would be theatre.
     */
    selected() {
      if (this.channelCount <= 1) return 0;
      return this.selectedIndex < 0 ? null : this.selectedIndex;
    }
    /** Number of non-silent windows evaluated so far. For tests and diagnostics. */
    windowsEvaluated() {
      return this.decisionCount;
    }
    /**
     * Feeds one hop of per-channel RMS, and returns the (possibly updated)
     * selection. `hopMs` weights the observation, so an irregular final hop
     * cannot count as much as a full one.
     *
     * Allocation-free. `rms` is read, never retained.
     */
    observe(rms, hopMs) {
      if (this.channelCount <= 1) return 0;
      if (!(hopMs > 0)) return this.selected();
      const channels = Math.min(this.channelCount, rms.length);
      for (let c = 0; c < channels; c++) {
        const level = rms[c] ?? 0;
        this.energy[c] = this.energy[c] + level * level * hopMs;
      }
      this.windowElapsedMs += hopMs;
      if (this.windowElapsedMs >= this.windowMs) this.closeWindow();
      return this.selected();
    }
    /** Forgets the latched selection and any window in progress. */
    reset() {
      for (let c = 0; c < this.energy.length; c++) this.energy[c] = 0;
      this.windowElapsedMs = 0;
      this.selectedIndex = -1;
      this.challenger = -1;
      this.challengerStreak = 0;
      this.decisionCount = 0;
    }
    /** Evaluates the completed window and starts a new one. */
    closeWindow() {
      const elapsed = this.windowElapsedMs;
      let best = 0;
      let bestRms = 0;
      for (let c = 0; c < this.channelCount; c++) {
        const level = Math.sqrt(this.energy[c] / elapsed);
        if (level > bestRms) {
          bestRms = level;
          best = c;
        }
      }
      if (bestRms >= this.silenceRms) {
        this.decisionCount += 1;
        if (this.selectedIndex < 0) {
          this.selectedIndex = best;
          this.challenger = -1;
          this.challengerStreak = 0;
        } else if (best === this.selectedIndex) {
          this.challengerStreak = 0;
          this.challenger = -1;
        } else {
          const incumbentRms = Math.sqrt(this.energy[this.selectedIndex] / elapsed);
          if (bestRms >= incumbentRms * this.marginRatio) {
            if (best === this.challenger) {
              this.challengerStreak += 1;
            } else {
              this.challenger = best;
              this.challengerStreak = 1;
            }
            if (this.challengerStreak >= this.sustainWindows) {
              this.selectedIndex = best;
              this.challenger = -1;
              this.challengerStreak = 0;
            }
          } else {
            this.challenger = -1;
            this.challengerStreak = 0;
          }
        }
      }
      for (let c = 0; c < this.energy.length; c++) this.energy[c] = 0;
      this.windowElapsedMs = 0;
    }
  };
  function resolveChannel(strategy, channelCount, selector) {
    if (channelCount <= 1) return 0;
    if (strategy === "sum") return null;
    if (typeof strategy === "number") {
      const index = Math.floor(strategy);
      return index >= 0 && index < channelCount ? index : null;
    }
    return selector ? selector.selected() : null;
  }
  function dbToRatio(db) {
    return Math.pow(10, db / 20);
  }

  // src/worklet/capture-processor.ts
  var DEFAULT_HOP_SAMPLES = 576;
  var POOL_LIMIT = 8;
  var CaptureProcessor = class extends AudioWorkletProcessor {
    hopSamples;
    strategy;
    silenceRms;
    /** The hop being filled, and how much of it is filled. */
    pending;
    pendingFilled = 0;
    startSample = 0;
    totalSamples = 0;
    /**
     * Buffers the host has returned. `postMessage` with a transfer neuters the
     * sender's view, so without recycling every hop allocates a fresh
     * Float32Array on the audio thread — 80 allocations a second, forever.
     */
    pool = [];
    selector = null;
    selectorChannels = 0;
    appliedChannel = -1;
    /** Scratch for the multi-channel downmix. Sized to the render quantum. */
    mixBuffer = new Float32Array(128);
    channelSquares = [];
    channelRms = [];
    channelSamples = 0;
    constructor(options) {
      super(options);
      const processorOptions = options?.processorOptions ?? {};
      this.hopSamples = Math.max(
        128,
        Math.floor(processorOptions.hopSamples ?? DEFAULT_HOP_SAMPLES)
      );
      this.strategy = processorOptions.channels ?? "auto";
      this.silenceRms = processorOptions.rmsGate ?? 8e-3;
      this.pending = new Float32Array(this.hopSamples);
      this.port.onmessage = (event) => {
        const command = event.data;
        if (command.type !== "recycle") return;
        if (this.pool.length < POOL_LIMIT) this.pool.push(command.buffer);
      };
    }
    process(inputs) {
      const input = inputs[0];
      const first = input?.[0];
      if (!input || !first || first.length === 0) {
        return true;
      }
      this.syncSelector(input.length);
      const channel = resolveChannel(this.strategy, input.length, this.selector);
      this.appliedChannel = channel ?? -1;
      let block = first;
      if (channel !== null) {
        block = input[channel] ?? first;
      } else if (input.length > 1) {
        if (this.mixBuffer.length !== first.length) {
          this.mixBuffer = new Float32Array(first.length);
        }
        const mix = this.mixBuffer;
        mix.set(first);
        for (let c = 1; c < input.length; c++) {
          const other = input[c];
          if (!other || other.length !== mix.length) continue;
          for (let i = 0; i < mix.length; i++) mix[i] = mix[i] + other[i];
        }
        block = mix;
      }
      this.meterChannels(input, first.length);
      this.accumulate(block, input.length);
      return true;
    }
    /** Fills the pending hop, posting it whenever it is complete. */
    accumulate(block, channelCount) {
      let offset = 0;
      while (offset < block.length) {
        const room = this.hopSamples - this.pendingFilled;
        const take = Math.min(room, block.length - offset);
        this.pending.set(block.subarray(offset, offset + take), this.pendingFilled);
        this.pendingFilled += take;
        offset += take;
        this.totalSamples += take;
        if (this.pendingFilled < this.hopSamples) continue;
        const samples = this.pending;
        this.pending = this.take();
        this.pendingFilled = 0;
        const message = {
          type: "chunk",
          samples,
          startSample: this.startSample,
          channelRms: this.readChannelMeters(channelCount),
          selectedChannel: this.appliedChannel < 0 ? null : this.appliedChannel
        };
        this.startSample = this.totalSamples;
        this.port.postMessage(message, [samples.buffer]);
      }
    }
    take() {
      const recycled = this.pool.pop();
      if (recycled !== void 0 && recycled.byteLength === this.hopSamples * 4) {
        return new Float32Array(recycled);
      }
      return new Float32Array(this.hopSamples);
    }
    /**
     * Creates (or recreates) the selector once the browser's real channel count
     * is known. Allocates on the first call and then never again, unless the
     * channel count itself changes, which a live `MediaStream` does not do.
     */
    syncSelector(channels) {
      if (this.strategy !== "auto" || channels <= 1) {
        this.selector = null;
        this.selectorChannels = channels;
        return;
      }
      if (this.selector && this.selectorChannels === channels) return;
      this.selectorChannels = channels;
      this.selector = new ChannelSelector({
        channelCount: channels,
        // The engine's own gate doubles as the "is anyone playing?" floor: below
        // it no channel would produce a pitch, so which one is loudest is both
        // unanswerable and irrelevant.
        silenceRms: this.silenceRms
      });
    }
    /**
     * Accumulates the *unsummed* level of every input channel.
     *
     * It erases the one fact a user needs when nothing is detected — whether the
     * instrument is on a channel at all — unless it is measured before the
     * channels are mixed; that is what lets a UI show "ch0 dead, ch1 hot". And it
     * is the input the channel selector decides on.
     */
    meterChannels(input, frames) {
      for (let c = 0; c < input.length; c++) {
        const channel = input[c];
        if (!channel) continue;
        let sum = 0;
        for (let i = 0; i < channel.length; i++) {
          sum += channel[i] * channel[i];
        }
        this.channelSquares[c] = (this.channelSquares[c] ?? 0) + sum;
      }
      this.channelSamples += frames;
    }
    readChannelMeters(channels) {
      const samples = this.channelSamples;
      const out = [];
      this.channelRms.length = channels;
      for (let c = 0; c < channels; c++) {
        const squares = this.channelSquares[c] ?? 0;
        const value = samples === 0 ? 0 : Math.sqrt(squares / samples);
        this.channelRms[c] = value;
        out.push(value);
      }
      if (this.selector && samples > 0) {
        this.selector.observe(this.channelRms, samples / sampleRate * 1e3);
      }
      this.resetChannelMeters();
      return out;
    }
    resetChannelMeters() {
      for (let c = 0; c < this.channelSquares.length; c++) this.channelSquares[c] = 0;
      this.channelSamples = 0;
    }
  };
  registerProcessor("tuninator-capture", CaptureProcessor);
})();
