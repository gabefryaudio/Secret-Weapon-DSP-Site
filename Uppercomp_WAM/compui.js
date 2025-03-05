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
    this.patchConnection.removeEndpointListener('gainReduction', this.gainReductionListener);
    this.patchConnection.removeEndpointListener('inputMeter', this.inputMeterListener);
    this.patchConnection.removeEndpointListener('outputMeter', this.outputMeterListener);
  }

  // ------------------------------------------------------------------
  // Patch listeners
  // ------------------------------------------------------------------
  setupPatchListeners() {
    // Listen for parameter updates
    this.paramListener = ({ endpointID, value }) => {
      const knobObj = this.knobs[endpointID];
      if (!knobObj) return;
      knobObj.targetValue = value;
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

    // LED for post-saturation meter
    this.patchConnection.addEndpointListener('postSatMeter', (value) => {
      const led = this.querySelector('#saturationLed');
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
      const param = knobEl.dataset.param;
      const minVal = parseFloat(knobEl.dataset.min);
      const maxVal = parseFloat(knobEl.dataset.max);
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
      knobEl.addEventListener('touchstart', e => this.startKnobTouch(e, knobEl.dataset.param), { passive: false });
    });

    document.addEventListener('mousemove', e => this.handleKnobDrag(e));
    document.addEventListener('mouseup', () => this.stopKnobDrag());
    document.addEventListener('touchmove', e => this.handleKnobTouch(e), { passive: false });
    document.addEventListener('touchend', () => this.stopKnobDrag());
  }

  startKnobDrag(e, param) {
    e.preventDefault();
    console.log(`Start dragging knob ${param} with mouse`);
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY = e.clientY;
  }

  startKnobTouch(e, param) {
    console.log(`Start dragging knob ${param} with touch`);
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY = e.touches[0].clientY;
  }

  handleKnobDrag(e) {
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging) {
        const deltaY = e.clientY - knob.lastY;
        console.log(`Dragging knob ${param}: deltaY=${deltaY}`);
        knob.lastY = e.clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });
  }

  handleKnobTouch(e) {
    const anyDragging = Object.keys(this.knobs).some(param => this.knobs[param].isDragging);
    if (anyDragging) {
      e.preventDefault();
    }
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging && e.touches.length) {
        const deltaY = e.touches[0].clientY - knob.lastY;
        console.log(`Touch dragging knob ${param}: deltaY=${deltaY}`);
        knob.lastY = e.touches[0].clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });
  }

  stopKnobDrag() {
    Object.keys(this.knobs).forEach(param => {
      if (this.knobs[param].isDragging) {
        console.log(`Stopped dragging knob ${param}`);
      }
      this.knobs[param].isDragging = false;
    });
  }

  // Increase sensitivity by using a higher sensitivity value
  adjustKnobValue(param, deltaY) {
    const knob = this.knobs[param];
    const range = knob.max - knob.min;
    const sensitivity = 1.0; // Adjust sensitivity if needed
    const change = (deltaY * sensitivity * range) / 100;
    console.log(`Knob ${param} change calculated: ${change}`);
    knob.targetValue = Math.max(knob.min, Math.min(knob.max, knob.targetValue - change));
  }

  updateKnobRotation(param, value) {
    const knob = this.knobs[param];
    const range = knob.max - knob.min;
    const pct = (value - knob.min) / range;
    // 270° total, offset -135 => 0 => -135°, 1 => +135°
    const deg = pct * 270 - 135;
    knob.element.style.transform = `rotate(${deg}deg)`;
  }

  updateKnobDisplayValue(param, value) {
    const knob = this.knobs[param];
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
    const dpr = window.devicePixelRatio || 1;
    this.waveformCanvas.width = rect.width * dpr;
    this.waveformCanvas.height = rect.height * dpr;
    this.waveformCanvas.style.width = `${rect.width}px`;
    this.waveformCanvas.style.height = `${rect.height}px`;
    this.ctx = this.waveformCanvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
  }


  drawWaveform() {
    if (!this.ctx || !this.waveformCanvas) return;
    const ctx = this.ctx;
    const w = this.waveformCanvas.width;
    const h = this.waveformCanvas.height;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    const dbLevels = [-60, -48, -36, -24, -12, 0, 12];
    dbLevels.forEach(db => {
      const y = this.dbToY(db, h);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = '#666';
      ctx.font = '10px "JetBrains Mono"';
      ctx.textAlign = 'right';
      ctx.fillText(`${db} dB`, w - 5, y - 5);
    });
    const timeDiv = 5;
    for (let i = 1; i < timeDiv; i++) {
      const x = w * (i / timeDiv);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    if (this.waveformHistory.length > 0) {
      const barW = w / this.historyLength;
      ctx.fillStyle = '#4CAF50';
      this.waveformHistory.forEach((sample, i) => {
        const x = i * barW;
        const lvl = sample.inputLevel;
        const y = this.dbToY(lvl, h);
        const barH = h - y;
        if (barH > 0) ctx.fillRect(x, y, barW - 1, barH);
      });
    }
    const thrY = this.dbToY(this.currentThresholdDb, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(0, thrY);
    ctx.lineTo(w, thrY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px "JetBrains Mono"';
    ctx.textAlign = 'left';
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
    this.initMeter('inputMeter', inputOutputDbMarkers, -36, 6, false);
    this.initMeter('outputMeter', inputOutputDbMarkers, -36, 6, false);
    this.initMeter('grMeter', gainReductionDbMarkers, 0, -36, true);
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
    this.posMeterScale('inputMeterScale', 'inputMeter', inputOutputDbMarkers, -36, 6);
    this.posMeterScale('grMeterScale', 'grMeter', gainReductionDbMarkers, 0, -36);
    this.posMeterScale('outputMeterScale', 'outputMeter', inputOutputDbMarkers, -36, 6);
  }

  posMeterScale(scaleId, dotsId, markers, minDb, maxDb) {
    const scaleEl = this.querySelector(`#${scaleId}`);
    const dotsEl = this.querySelector(`#${dotsId}`);
    if (!scaleEl || !dotsEl) return;
    scaleEl.innerHTML = '';
    const totalDots = 30;
    const stepW = 16;
    const rng = Math.abs(maxDb - minDb);
    const offset = 10;
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
  // Animation Loop (implements meter clearing logic)
  // ------------------------------------------------------------------
  animate() {
    if (this.meters.inputLevel.value < -50) {
      this.meters.gainReduction.value = 0;
      this.meters.gainReduction.peak = 0;
    }
    this.meters.inputLevel.peak = Math.max(
      this.meters.inputLevel.value,
      this.meters.inputLevel.peak - this.decayRate
    );
    this.meters.outputLevel.peak = Math.max(
      this.meters.outputLevel.value,
      this.meters.outputLevel.peak - this.decayRate
    );
    if (Math.abs(this.meters.gainReduction.value) < 0.05) {
      this.meters.gainReduction.peak = 0;
      this.meters.gainReduction.value = 0;
    } else {
      this.meters.gainReduction.peak = this.meters.gainReduction.value;
    }
    // Smooth knob transitions (easing multiplier increased to 0.5)
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      const diff = knob.targetValue - knob.currentValue;
      if (Math.abs(diff) > 0.0001) {
        knob.currentValue += diff * 0.5;
        this.updateKnobRotation(param, knob.currentValue);
        this.updateKnobDisplayValue(param, knob.currentValue);
        this.patchConnection.sendEventOrValue(param, knob.currentValue);
        if (param === 'thresholdDbIn') {
          this.currentThresholdDb = knob.currentValue;
        }
      }
    });
    this.frameCount++;
    if (this.frameCount >= this.historyUpdateRate) {
      this.frameCount = 0;
      this.waveformHistory.push({
        inputLevel: this.meters.inputLevel.value,
        gainReduction: this.meters.gainReduction.value,
        outputLevel: this.meters.outputLevel.value
      });
      if (this.waveformHistory.length > this.historyLength) {
        this.waveformHistory.shift();
      }
    }
    this.drawWaveform();
    this.updateMeters();
    this.animationFrameRequest = requestAnimationFrame(() => this.animate());
  }

  // ------------------------------------------------------------------
  // Meter-LED Coloring (zero out GR if near zero)
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
      const dots = meterEl.querySelectorAll('.meter-dot');
      const valEl = meterEl.parentElement.querySelector('.meter-value');
      let meterValue = this.meters[param].peak;
      if (param === 'gainReduction' && Math.abs(meterValue) < 0.05) {
        meterValue = 0.0;
      }
      if (valEl) {
        valEl.textContent = `${meterValue.toFixed(1)} dB`;
      }
      const total = dots.length;
      const rng = Math.abs(cfg.maxDb - cfg.minDb);
      const dbStep = rng / (total - 1);
      for (let i = 0; i < total; i++) {
        const dotDb = cfg.ascending
          ? cfg.minDb + i * dbStep
          : cfg.minDb - i * dbStep;
        let intensity;
        if (cfg.ascending) {
          if (meterValue >= dotDb) {
            intensity = 1.0;
          } else if (meterValue < dotDb - dbStep) {
            intensity = 0.0;
          } else {
            intensity = (meterValue - (dotDb - dbStep)) / dbStep;
          }
        } else {
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
        const activeColor = (param === 'gainReduction')
          ? redColor
          : (dotDb < -12 ? greenColor : (dotDb < 0 ? yellowColor : redColor));
        const color = lerpColor(offColor, activeColor, intensity);
        dots[i].style.background = color;
        dots[i].classList.toggle('active', intensity > 0);
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
      <style>
      @import url('https://fonts.googleapis.com/css2?family=Audiowide&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');
      :host {
        display: block;
        width: 100%;
        max-width: 1200px;
      }
      #compressor {
        position: relative;
        width: 100%;
        aspect-ratio: 3 / 1;
        max-width: 1200px;
        background: linear-gradient(145deg, #262626, #1e1e1e);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.8),
                    inset 0 1px 1px rgba(255,255,255,0.1);
        overflow: hidden;
        padding: 16px;
      }
      .sections-container {
        display: flex;
        gap: 16px;
        width: 100%;
        height: 100%;
      }
      .knobs-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 8px;
        flex: 3;
        position: relative;
      }
      .knob-row {
        display: flex;
        gap: 20px;
        justify-content: center;
      }
      .knob-wrapper {
        width: 80px;
        text-align: center;
      }
      #satWrapper { }
      #satMixWrapper { }
      .knob {
        width: 55px;
        height: 55px;
        cursor: pointer;
        filter: brightness(0.85) contrast(1.2)
                drop-shadow(0 4px 8px rgba(0,0,0,0.8));
        transition: filter 0.2s ease;
      }
      .knob:hover {
        filter: brightness(1) contrast(1.3)
                drop-shadow(0 6px 12px rgba(0,0,0,0.9));
      }
      .knob-label {
        font-size: 10px;
        color: #bbb;
        margin-top: 6px;
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        font-weight: 500;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .knob-value {
        font-size: 9px;
        color: #888;
        font-family: 'JetBrains Mono', monospace;
        margin-top: 3px;
        font-weight: 500;
      }
      .toggle-switches {
        display: flex;
        gap: 10px;
        align-items: center;
        margin-top: 8px;
        justify-content: center;
      }
      .toggle-button {
        padding: 5px 10px;
        border: none;
        background: #1a1a1a;
        color: #888;
        font-size: 9px;
        cursor: pointer;
        border-radius: 3px;
        transition: all 0.2s ease;
        font-weight: 500;
        letter-spacing: 0.5px;
        font-family: 'Inter', sans-serif;
        box-shadow: 0 2px 4px rgba(0,0,0,0.4),
                    inset 0 1px 1px rgba(255,255,255,0.1);
      }
      .toggle-button:hover {
        color: #bbb;
      }
      .toggle-button.active {
        background: #2E7D32;
        color: #fff;
        box-shadow:
          inset 0 1px 1px rgba(255,255,255,0.2),
          0 0 4px rgba(76,175,80,0.4);
      }
      .visualization-section {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        padding: 8px;
        flex: 4;
      }
      .visualization-box {
        background: linear-gradient(to bottom, #1a1a1a, #222);
        border-radius: 8px;
        border: 1px solid #333;
        box-shadow: inset 0 0 20px rgba(0,0,0,0.4);
        width: 100%;
        height: 100%;
        padding: 8px;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      #title {
        font-family: 'Audiowide', sans-serif;
        font-size: 20px;
        color: #ddd;
        text-align: center;
        margin: 0;
        margin-bottom: 8px;
        text-shadow: 0 0 10px rgba(76,175,80,0.3);
        letter-spacing: 3px;
      }
      #waveform {
        width: 100%;
        height: 100%;
      }
      .meters-section {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 8px;
        flex: 2;
        margin-top: -16px;
      }
      .meter-block {
        display: flex;
        flex-direction: column;
        margin-bottom: 6px;
      }
      .meter-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .meter-label {
        font-size: 10px;
        color: #bbb;
        font-weight: 500;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .meter-value {
        font-size: 10px;
        font-family: 'JetBrains Mono', monospace;
        color: #888;
        font-weight: 500;
      }
      .meter-dots {
        display: flex;
        gap: 3px;
        padding: 3px;
        background: rgba(0,0,0,0.2);
        border-radius: 3px;
        box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
        position: relative;
        height: 16px;
      }
      .meter-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #333;
        border: 1px solid #222;
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);
      }
      .meter-scale {
        position: absolute;
        left: 4px;
        right: 4px;
        bottom: -18px;
        height: 14px;
        display: flex;
        justify-content: space-between;
      }
      .scale-marker {
        position: absolute;
        color: #999;
        font-size: 8px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 500;
        transform: translateX(-50%);
      }
      .meter-dot.active {
        background: #4CAF50;
        border-color: #2E7D32;
        box-shadow:
          inset 0 1px 2px rgba(255,255,255,0.3),
          0 0 4px rgba(76,175,80,0.8);
      }
      #grMeter .meter-dot.active {
        background: #F44336;
        border-color: #C62828;
        box-shadow:
          inset 0 1px 2px rgba(255,255,255,0.3),
          0 0 4px rgba(244,67,54,0.8);
      }
      .logo-container {
        position: absolute;
        bottom: 40px;
        right: 100px;
        opacity: 0.85;
        transition: opacity 0.2s ease;
      }
      .logo-container:hover {
        opacity: 1.0;
      }
      .secret-weapon-logo {
        width: 150px;
        height: auto;
      }
      /* --- LED Styles --- */
      #saturationLedWrapper {
        position: absolute;
        width: 30px;
        height: 14px;
        pointer-events: none;
      }
      #saturationLed {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background-color: #444;
      }
      #saturationLed.on {
        background-color: #FF0000;
        box-shadow: 0 0 12px 4px rgba(255, 0, 0, 1.0);
      }
      </style>
      <div id="compressor">
        <div class="sections-container">
          <!-- Knobs Section -->
          <div class="knobs-section">
            <div class="knob-row">
              <!-- drive (Saturation) -->
              <div class="knob-wrapper" id="satWrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="drive" data-min="0.1" data-max="10" data-value="1.0">
                <div class="knob-label">Saturation</div>
                <div class="knob-value">0.9</div>
              </div>
              <!-- satMixIn (Saturation Mix) -->
              <div class="knob-wrapper" id="satMixWrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="satMixIn" data-min="0" data-max="1" data-value="1.0">
                <div class="knob-label">Saturation Mix</div>
                <div class="knob-value">1.0</div>
              </div>
              <!-- inputGainIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="inputGainIn" data-min="-25" data-max="25" data-value="0.0">
                <div class="knob-label">Comp In Gain</div>
                <div class="knob-value">0.0 dB</div>
              </div>
              <!-- ratioIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="ratioIn" data-min="1" data-max="10" data-value="4.0">
                <div class="knob-label">Ratio</div>
                <div class="knob-value">4.0:1</div>
              </div>
              <!-- thresholdDbIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="thresholdDbIn" data-min="-60" data-max="0" data-value="-28.0">
                <div class="knob-label">Threshold</div>
                <div class="knob-value">-28.0 dB</div>
              </div>
            </div>
            <!-- LED for Saturation -->
            <div id="saturationLedWrapper" class="led-wrapper">
              <div id="saturationLed"></div>
            </div>
            <div class="knob-row">
              <!-- lookaheadMsIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="lookaheadMsIn" data-min="0" data-max="50" data-value="5.0">
                <div class="knob-label">Lookahead</div>
                <div class="knob-value">5.0 ms</div>
              </div>
              <!-- attackMsIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="attackMsIn" data-min="1" data-max="100" data-value="25.0">
                <div class="knob-label">Attack</div>
                <div class="knob-value">25.0 ms</div>
              </div>
              <!-- releaseMsIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="releaseMsIn" data-min="10" data-max="500" data-value="80.0">
                <div class="knob-label">Release</div>
                <div class="knob-value">80.0 ms</div>
              </div>
              <!-- outputGainIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="outputGainIn" data-min="-25" data-max="25" data-value="0.0">
                <div class="knob-label">Output Gain</div>
                <div class="knob-value">0.0 dB</div>
              </div>
              <!-- sidechainFreqIn -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="sidechainFreqIn" data-min="20" data-max="20000" data-value="200.0">
                <div class="knob-label">Sidechain Freq</div>
                <div class="knob-value">200.0 Hz</div>
              </div>
            </div>
            <div class="toggle-switches">
              <button class="toggle-button" data-param="enableLookAheadIn">
                LOOKAHEAD ENABLED
              </button>
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865/White%20Knob.svg"
                     data-param="compMixIn" data-min="0" data-max="1" data-value="1.0">
                <div class="knob-label">Comp Mix</div>
                <div class="knob-value">1.0</div>
              </div>
              <button class="toggle-button" data-param="sidechainFilterEnableIn">
                SIDECHAIN FILTER ENABLED
              </button>
            </div>
          </div>
          <!-- Visualization Section -->
          <div class="visualization-section">
            <div class="visualization-box">
              <h1 id="title">UPPERCOMP</h1>
              <canvas id="waveform"></canvas>
            </div>
          </div>
          <!-- Meters Section -->
          <div class="meters-section">
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Input Level</span>
                <span class="meter-value">-36.0 dB</span>
              </div>
              <div class="meter-dots" id="inputMeter">
                ${makeDots()}
              </div>
              <div class="meter-scale" id="inputMeterScale"></div>
            </div>
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Gain Reduction</span>
                <span class="meter-value">0.0 dB</span>
              </div>
              <div class="meter-dots" id="grMeter">
                ${makeDots()}
              </div>
              <div class="meter-scale" id="grMeterScale"></div>
            </div>
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Output Level</span>
                <span class="meter-value">-36.0 dB</span>
              </div>
              <div class="meter-dots" id="outputMeter">
                ${makeDots()}
              </div>
              <div class="meter-scale" id="outputMeterScale"></div>
            </div>
            <div class="logo-container">
              <img
                class="secret-weapon-logo"
                src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/refs/heads/main/Secret%20Weapon%20DSP%20logo%20(straight).svg"
                alt="Secret Weapon DSP Logo"
              />
            </div>
          </div>
        </div>
      </div>
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
