/**
 * UpperCompGUI.js
 *
 * A simplified version that uses pure CSS sizing with an aspect ratio,
 * rather than manual transform scaling or ResizeObservers.
 */

// --------------------------------------------------------------------
// Meter / Color / Easing Definitions (same as code A)
// --------------------------------------------------------------------
const inputOutputDbMarkers = [-36, -30, -24, -18, -12, -6, 0, 6];
const gainReductionDbMarkers = [0, -6, -12, -18, -24, -30, -36];

const offColor = [51, 51, 51];
const greenColor = [76, 175, 80];
const yellowColor = [255, 235, 59];
const redColor = [255, 82, 82];

/** Easing for LED meter brightness transitions */
function cubicEase(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Interpolate between offColor and onColor by a "cubic ease" factor t */
function lerpColor(offColor, onColor, t) {
  const eased = cubicEase(t);
  const r = Math.round(offColor[0] + (onColor[0] - offColor[0]) * eased);
  const g = Math.round(offColor[1] + (onColor[1] - offColor[1]) * eased);
  const b = Math.round(offColor[2] + (onColor[2] - offColor[2]) * eased);
  return `rgb(${r}, ${g}, ${b})`;
}

// --------------------------------------------------------------------
// Main UpperCompGUI Element
// --------------------------------------------------------------------
class UpperCompGUI extends HTMLElement {
  constructor(patchConnection) {
    super();
    this.patchConnection = patchConnection;

    // Basic meter defaults
    this.meters = {
      gainReduction: { value: 0, peak: 0 },
      inputLevel:    { value: -36, peak: -36 },
      outputLevel:   { value: -36, peak: -36 }
    };
    this.decayRate = 0.5; // dB per animation frame

    // Waveform
    this.waveformCanvas = null;
    this.ctx = null;
    this.waveformHistory = [];
    this.historyLength = 30;
    this.historyUpdateRate = 1;
    this.frameCount = 0;
    this.currentThresholdDb = -28.0; // Default threshold

    // Insert the HTML
    this.innerHTML = this.getHTML();
  }

  connectedCallback() {
    this.initializeKnobs();
    this.initializeWaveform();
    this.setupPatchListeners();

    // Handle toggle buttons
    this.querySelectorAll('.toggle-button').forEach(button => {
      const param = button.dataset.param;
      button.addEventListener('click', () => {
        const newState = !button.classList.contains('active');
        button.classList.toggle('active', newState);
        this.patchConnection.sendEventOrValue(param, newState);
      });
    });

    // Request initial knob/toggle states
    Object.keys(this.knobs).forEach(param => {
      this.patchConnection.requestParameterValue(param);
    });
    this.patchConnection.requestParameterValue('enableLookAheadIn');
    this.patchConnection.requestParameterValue('sidechainFilterEnableIn');

    // Initialize meters with dB markers
    this.initializeMetersWithMarkers();

    // Position the saturation LED between the Saturation and Saturation Mix knobs
    this.positionSaturationLed();
    window.addEventListener('resize', () => this.positionSaturationLed());

    // Start main animation loop
    this.animationFrameRequest = requestAnimationFrame(() => this.animate());
  }

  disconnectedCallback() {
    if (this.animationFrameRequest) {
      cancelAnimationFrame(this.animationFrameRequest);
    }
    if (this.paramListener) {
      this.patchConnection.removeAllParameterListener(this.paramListener);
    }
    this.patchConnection.removeEndpointListener('gainReduction',   this.gainReductionListener);
    this.patchConnection.removeEndpointListener('inputMeter',      this.inputMeterListener);
    this.patchConnection.removeEndpointListener('outputMeter',     this.outputMeterListener);
  }

  // ------------------------------------------------------------------
  // Patch listeners
  // ------------------------------------------------------------------
  setupPatchListeners() {
    // Listen for parameter updates
    this.paramListener = ({ endpointID, value }) => {
      const knobObj = this.knobs[endpointID];
      if (!knobObj) return;
      knobObj.targetValue  = value;
      knobObj.currentValue = value;
      this.updateKnobRotation(endpointID, value);
      this.updateKnobDisplayValue(endpointID, value);

      if (endpointID === 'thresholdDbIn') {
        this.currentThresholdDb = value;
        this.drawWaveform();
      }
    };
    this.patchConnection.addAllParameterListener(this.paramListener);

    // Meters
    this.gainReductionListener = (value) => {
      this.meters.gainReduction.value = value;
    };
    this.patchConnection.addEndpointListener('gainReduction', this.gainReductionListener);

    this.inputMeterListener = (value) => {
      this.meters.inputLevel.value = value;
    };
    this.patchConnection.addEndpointListener('inputMeter', this.inputMeterListener);

    this.outputMeterListener = (value) => {
      this.meters.outputLevel.value = value;
    };
    this.patchConnection.addEndpointListener('outputMeter', this.outputMeterListener);

    // Toggle states
    this.patchConnection.addEndpointListener('enableLookAheadIn', (v) => {
      const btn = this.querySelector('.toggle-button[data-param="enableLookAheadIn"]');
      if (btn) btn.classList.toggle('active', v);
    });
    this.patchConnection.addEndpointListener('sidechainFilterEnableIn', (v) => {
      const btn = this.querySelector('.toggle-button[data-param="sidechainFilterEnableIn"]');
      if (btn) btn.classList.toggle('active', v);
    });

    // -----------------------------
    // LED for post-saturation meter
    // -----------------------------
    this.patchConnection.addEndpointListener('postSatMeter', (value) => {
      const led = this.querySelector('#saturationLed');
      // Set a threshold for turning the LED on (adjust as needed)
      const ledThreshold = 8.0;
      if (led) {
        if (value >= ledThreshold) {
          led.classList.add('on');
        } else {
          led.classList.remove('on');
        }
      }
    });
  }

  // ------------------------------------------------------------------
  // Knobs
  // ------------------------------------------------------------------
  initializeKnobs() {
    this.knobs = {};
    const knobEls = this.querySelectorAll('.knob');
    knobEls.forEach(knobEl => {
      const param   = knobEl.dataset.param;
      const minVal  = parseFloat(knobEl.dataset.min);
      const maxVal  = parseFloat(knobEl.dataset.max);
      const initVal = parseFloat(knobEl.dataset.value);
      this.knobs[param] = {
        element: knobEl,
        currentValue: initVal,
        targetValue: initVal,
        min: minVal,
        max: maxVal,
        isDragging: false,
        lastY: 0
      };
      // Initialize rotation & display
      this.updateKnobRotation(param, initVal);
      this.updateKnobDisplayValue(param, initVal);
    });
    this.setupKnobDragEvents();
  }

  setupKnobDragEvents() {
    const knobEls = this.querySelectorAll('.knob');
    knobEls.forEach(knobEl => {
      knobEl.addEventListener('mousedown', e => this.startKnobDrag(e, knobEl.dataset.param));
      // Removed e.preventDefault() from startKnobTouch to avoid blocking scroll on mere touch
      knobEl.addEventListener('touchstart', e => this.startKnobTouch(e, knobEl.dataset.param), { passive: false });
    });

    document.addEventListener('mousemove',  e => this.handleKnobDrag(e));
    document.addEventListener('mouseup',    () => this.stopKnobDrag());
    // Only preventDefault if a knob is actually being dragged
    document.addEventListener('touchmove',  e => this.handleKnobTouch(e), { passive: false });
    document.addEventListener('touchend',   () => this.stopKnobDrag());
  }

  startKnobDrag(e, param) {
    e.preventDefault(); // Typically OK for mouse usage
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY      = e.clientY;
  }

  startKnobTouch(e, param) {
    // Don't call e.preventDefault() here => allow normal scrolling unless actually dragging
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY      = e.touches[0].clientY;
  }

  handleKnobDrag(e) {
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging) {
        const deltaY = e.clientY - knob.lastY;
        knob.lastY   = e.clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });
  }

  handleKnobTouch(e) {
    // Check if any knob is actively dragging; only then block default scroll
    let anyKnobDragging = false;

    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging && e.touches.length) {
        anyKnobDragging = true;
        const deltaY = e.touches[0].clientY - knob.lastY;
        knob.lastY   = e.touches[0].clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });

    if (anyKnobDragging) {
      e.preventDefault();
    }
  }

  stopKnobDrag() {
    Object.keys(this.knobs).forEach(param => {
      this.knobs[param].isDragging = false;
    });
  }

  adjustKnobValue(param, deltaY) {
    const knob  = this.knobs[param];
    const range = knob.max - knob.min;
    const sensitivity = 0.3;
    const change = (deltaY * sensitivity * range) / 100;
    knob.targetValue = Math.max(knob.min, Math.min(knob.max, knob.targetValue - change));
  }

  updateKnobRotation(param, value) {
    const knob  = this.knobs[param];
    const range = knob.max - knob.min;
    const pct   = (value - knob.min) / range;
    // 270° total, offset -135 => 0 => -135°, 1 => +135°
    const deg   = pct * 270 - 135;
    knob.element.style.transform = `rotate(${deg}deg)`;
  }

  updateKnobDisplayValue(param, value) {
    const knob  = this.knobs[param];
    const label = knob.element.parentElement.querySelector('.knob-value');
    if (!label) return;

    let text = '';
    switch (param) {
      case 'drive':
        text = value.toFixed(1);
        break;
      case 'satMixIn':
        text = value.toFixed(2);
        break;
      case 'ratioIn':
        text = `${value.toFixed(1)}:1`;
        break;
      case 'thresholdDbIn':
        text = `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
        break;
      case 'lookaheadMsIn':
      case 'attackMsIn':
      case 'releaseMsIn':
        text = `${value.toFixed(1)} ms`;
        break;
      case 'inputGainIn':
      case 'outputGainIn':
        text = `${value.toFixed(2)} dB`;
        break;
      case 'sidechainFreqIn':
        text = `${value.toFixed(1)} Hz`;
        break;
      case 'compMixIn':
        text = value.toFixed(2);
        break;
      default:
        text = value.toFixed(1);
    }
    label.textContent = text;
  }

  // ------------------------------------------------------------------
  // Waveform
  // ------------------------------------------------------------------
  initializeWaveform() {
    this.waveformCanvas = this.querySelector('#waveform');
    if (!this.waveformCanvas) return;
    const rect = this.waveformCanvas.getBoundingClientRect();
    this.waveformCanvas.width  = rect.width;
    this.waveformCanvas.height = rect.height;
    this.ctx = this.waveformCanvas.getContext('2d');
  }

  drawWaveform() {
    if (!this.ctx || !this.waveformCanvas) return;
    const ctx = this.ctx;
    const w   = this.waveformCanvas.width;
    const h   = this.waveformCanvas.height;

    // Clear
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    // Horizontal dB lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth   = 1;
    const dbLevels  = [-60, -48, -36, -24, -12, 0, 12];
    dbLevels.forEach(db => {
      const y = this.dbToY(db, h);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();

      ctx.fillStyle  = '#666';
      ctx.font       = '10px "JetBrains Mono"';
      ctx.textAlign  = 'right';
      ctx.fillText(`${db} dB`, w - 5, y - 5);
    });

    // Vertical lines
    const timeDiv = 5;
    for (let i = 1; i < timeDiv; i++) {
      const x = w * (i / timeDiv);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Waveform history bars (green)
    if (this.waveformHistory.length > 0) {
      const barW = w / this.historyLength;
      ctx.fillStyle = '#4CAF50';
      this.waveformHistory.forEach((sample, i) => {
        const x   = i * barW;
        const lvl = sample.inputLevel;
        const y   = this.dbToY(lvl, h);
        const barH= h - y;
        if (barH > 0) ctx.fillRect(x, y, barW - 1, barH);
      });
    }

    // Threshold line
    const thrY = this.dbToY(this.currentThresholdDb, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(0, thrY);
    ctx.lineTo(w, thrY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle  = 'rgba(255,255,255,0.7)';
    ctx.font       = '11px "JetBrains Mono"';
    ctx.textAlign  = 'left';
    ctx.fillText(`Threshold: ${this.currentThresholdDb.toFixed(1)} dB`, 10, thrY - 5);
  }

  dbToY(db, height) {
    const minDb = -60;
    const maxDb = 12;
    const dbRange = maxDb - minDb;
    const clamped = Math.max(minDb, Math.min(maxDb, db));
    const norm = (clamped - minDb) / dbRange;
    return height * (1 - norm);
  }

  // ------------------------------------------------------------------
  // Meters
  // ------------------------------------------------------------------
  initializeMetersWithMarkers() {
    this.initMeter('inputMeter',  inputOutputDbMarkers,  -36, 6,  false);
    this.initMeter('outputMeter', inputOutputDbMarkers,  -36, 6,  false);
    this.initMeter('grMeter',     gainReductionDbMarkers, 0,   -36, true);
    this.positionAllScaleMarkers();
  }

  initMeter(meterId, markers, minDb, maxDb, reversed) {
    const el = this.querySelector(`#${meterId}`);
    if (!el) return;
    const dots = el.querySelectorAll('.meter-dot');
    const total = dots.length;
    const rng = Math.abs(maxDb - minDb);

    markers.forEach(marker => {
      const frac = reversed
        ? (minDb - marker) / rng
        : (marker - minDb) / rng;
      const idx = Math.round(Math.max(0, Math.min(1, frac)) * (total - 1));
      dots[idx].classList.add('marker-led');
      dots[idx].dataset.dbValue = marker;
    });
  }

  positionAllScaleMarkers() {
    this.posMeterScale('inputMeterScale',  'inputMeter',  inputOutputDbMarkers,  -36, 6);
    this.posMeterScale('grMeterScale',     'grMeter',     gainReductionDbMarkers, 0,   -36);
    this.posMeterScale('outputMeterScale','outputMeter', inputOutputDbMarkers,  -36, 6);
  }

  posMeterScale(scaleId, dotsId, markers, minDb, maxDb) {
    const scaleEl = this.querySelector(`#${scaleId}`);
    const dotsEl  = this.querySelector(`#${dotsId}`);
    if (!scaleEl || !dotsEl) return;
    scaleEl.innerHTML = '';

    const totalDots = 30;  // Your meter-dot count
    const stepW     = 16;  // Each dot+gap ~16px
    const rng       = Math.abs(maxDb - minDb);
    const offset    = 10;  // Horizontal shift so label centers under dot

    markers.forEach(dbVal => {
      const frac = (minDb < maxDb)
        ? (dbVal - minDb) / rng
        : (minDb - dbVal) / rng;
      const i = Math.round(Math.max(0, Math.min(1, frac)) * (totalDots - 1));

      const label = document.createElement('div');
      label.classList.add('scale-marker');
      label.textContent = dbVal > 0 ? `+${dbVal} dB` : `${dbVal} dB`;
      label.style.left = `${offset + i * stepW}px`;
      scaleEl.appendChild(label);
    });
  }

  // ------------------------------------------------------------------
  // Updated Animation Loop (implements code A's meter clearing logic)
  // ------------------------------------------------------------------
  animate() {
    // 1) If input is very low, force gain reduction to zero
    if (this.meters.inputLevel.value < -50) {
      this.meters.gainReduction.value = 0;
      this.meters.gainReduction.peak  = 0;
    }

    // 2) Decay peaks for input & output
    this.meters.inputLevel.peak = Math.max(
      this.meters.inputLevel.value,
      this.meters.inputLevel.peak - this.decayRate
    );
    this.meters.outputLevel.peak = Math.max(
      this.meters.outputLevel.value,
      this.meters.outputLevel.peak - this.decayRate
    );

    // 3) If the gain reduction is near zero, force it to 0
    //    (prevents "hanging" with tiny dB values)
    if (Math.abs(this.meters.gainReduction.value) < 0.05) {
      this.meters.gainReduction.peak  = 0;
      this.meters.gainReduction.value = 0;
    } else {
      // Otherwise let it track the current value
      this.meters.gainReduction.peak = this.meters.gainReduction.value;
    }

    // 4) Smooth knob transitions
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      const diff = knob.targetValue - knob.currentValue;
      if (Math.abs(diff) > 0.0001) {
        knob.currentValue += diff * 0.2;
        this.updateKnobRotation(param, knob.currentValue);
        this.updateKnobDisplayValue(param, knob.currentValue);
        this.patchConnection.sendEventOrValue(param, knob.currentValue);

        if (param === 'thresholdDbIn') {
          this.currentThresholdDb = knob.currentValue;
        }
      }
    });

    // 5) Waveform history
    this.frameCount++;
    if (this.frameCount >= this.historyUpdateRate) {
      this.frameCount = 0;
      this.waveformHistory.push({
        inputLevel:    this.meters.inputLevel.value,
        gainReduction: this.meters.gainReduction.value,
        outputLevel:   this.meters.outputLevel.value
      });
      if (this.waveformHistory.length > this.historyLength) {
        this.waveformHistory.shift();
      }
    }

    // 6) Redraw the waveform & meters
    this.drawWaveform();
    this.updateMeters();

    // Request next frame
    this.animationFrameRequest = requestAnimationFrame(() => this.animate());
  }

  // ------------------------------------------------------------------
  // Updated Meter-LED Coloring
  // ------------------------------------------------------------------
  updateMeters() {
    const meterMap = {
      inputLevel: {
        id: 'inputMeter', minDb: -36, maxDb: 6, ascending: true
      },
      gainReduction: {
        id: 'grMeter', minDb: 0, maxDb: -36, ascending: false
      },
      outputLevel: {
        id: 'outputMeter', minDb: -36, maxDb: 6, ascending: true
      }
    };

    Object.keys(meterMap).forEach(param => {
      const cfg = meterMap[param];
      const meterEl = this.querySelector(`#${cfg.id}`);
      if (!meterEl) return;

      const dots  = meterEl.querySelectorAll('.meter-dot');
      const valEl = meterEl.parentElement.querySelector('.meter-value');

      // If gainReduction is near zero, forcibly display as 0.0
      let meterValue = this.meters[param].peak;
      if (param === 'gainReduction' && Math.abs(meterValue) < 0.05) {
        meterValue = 0.0;
      }

      // Update numeric readout
      if (valEl) {
        valEl.textContent = `${meterValue.toFixed(1)} dB`;
      }

      // For per-dot coloring:
      const total  = dots.length;
      const rng    = Math.abs(cfg.maxDb - cfg.minDb);
      const dbStep = rng / (total - 1);

      for (let i = 0; i < total; i++) {
        const dotDb = cfg.ascending
          ? cfg.minDb + i * dbStep
          : cfg.minDb - i * dbStep;

        let intensity;
        if (cfg.ascending) {
          // For input/output
          if (meterValue >= dotDb) {
            intensity = 1.0;
          } else if (meterValue < dotDb - dbStep) {
            intensity = 0.0;
          } else {
            intensity = (meterValue - (dotDb - dbStep)) / dbStep;
          }
        } else {
          // For gain reduction
          // clampVal ensures we never go above 0 dB for GR
          const clampVal = Math.min(0, meterValue);
          if (clampVal >= -0.01) {
            intensity = 0.0;
          } else if (clampVal <= dotDb) {
            intensity = 1.0;
          } else if (clampVal > dotDb + dbStep) {
            intensity = 0.0;
          } else {
            intensity = (dotDb + dbStep - clampVal) / dbStep;
          }
        }

        intensity = Math.max(0, Math.min(1, intensity));

        // Pick color
        const activeColor =
          (param === 'gainReduction')
            ? redColor
            : (dotDb < -12 ? greenColor : (dotDb < 0 ? yellowColor : redColor));

        // Interpolate
        const color = lerpColor(offColor, activeColor, intensity);
        dots[i].style.background = color;
        dots[i].classList.toggle('active', intensity > 0);

        // Slight glow if marker-led & intensity > 0.5
        dots[i].style.boxShadow =
          (dots[i].classList.contains('marker-led') && intensity > 0.5)
            ? '0 0 4px rgba(255,255,255,0.3)'
            : 'none';
      }
    });
  }

  // ------------------------------------------------------------------
  // Position the Saturation LED between the Saturation and Saturation Mix knobs
  // ------------------------------------------------------------------
  positionSaturationLed() {
    const satWrapper = this.querySelector('#satWrapper');
    const satMixWrapper = this.querySelector('#satMixWrapper');
    const ledWrapper = this.querySelector('#saturationLedWrapper');
    const knobsSection = this.querySelector('.knobs-section');
    if (satWrapper && satMixWrapper && ledWrapper && knobsSection) {
      const satRect = satWrapper.getBoundingClientRect();
      const satMixRect = satMixWrapper.getBoundingClientRect();
      const containerRect = knobsSection.getBoundingClientRect();
      const gap = satMixRect.left - satRect.right;
      const ledCenterX = satRect.right + gap / 2;
      const leftPos = ledCenterX - containerRect.left - (ledWrapper.offsetWidth / 2);
      const topPos = satRect.top - containerRect.top + (satRect.height / 2) - (ledWrapper.offsetHeight / 2);
      ledWrapper.style.left = `${leftPos}px`;
      ledWrapper.style.top = `${topPos}px`;
    }
  }

  // ------------------------------------------------------------------
  // Main GUI HTML
  // ------------------------------------------------------------------
  getHTML() {
    const makeDots = () => '<div class="meter-dot"></div>'.repeat(24);

    return `
      <!-- All the HTML layout for your custom compressor UI goes here -->
      <!-- (Same as in your original code, omitted for brevity in this snippet) -->
    `;
  }
}

// Register the custom element
customElements.define('upper-comp-gui', UpperCompGUI);

/**
 * Factory function for your .cmajorpatch manifest
 */
export default function createPatchView(patchConnection) {
  return new UpperCompGUI(patchConnection);
}
