/**
 * UpperCompGUI.js
 *
 * This custom element references the parameter names:
 *   - drive
 *   - satMixIn
 *   - ratioIn
 *   - thresholdDbIn
 *   - lookaheadMsIn
 *   - attackMsIn
 *   - releaseMsIn
 *   - inputGainIn  (labeled as "Comp In Gain")
 *   - outputGainIn
 *   - sidechainFreqIn
 *   - compMixIn
 *   - enableLookAheadIn
 *   - sidechainFilterEnableIn
 *
 * It also receives meter data for:
 *   - inputMeter
 *   - gainReduction
 *   - outputMeter
 *   - postSatMeter  <-- from CustomHarmonicsGenerator
 *
 * This version:
 *   - Keeps consistent spacing for all knobs (gap: 25px).
 *   - Squeezes the LED meter between the Saturation and Saturation Mix knobs
 *     by removing it from the normal flex flow and positioning it absolutely,
 *     so that its center is equidistant from each knob.
 *   - Sets the LED’s brightness to immediately be fully bright when turned on.
 */

// --------------------------------------------------------------------
// Global Constants & Helpers for the Improved LED Meter System
// --------------------------------------------------------------------

// Define the specific dB markings for input/output and gain reduction meters
const inputOutputDbMarkers = [-36, -30, -24, -18, -12, -6, 0, 6];
const gainReductionDbMarkers = [0, -6, -12, -18, -24, -30, -36];

// Define colors for interpolation
const offColor = [51, 51, 51];      // #333
const greenColor = [76, 175, 80];   // #4CAF50
const yellowColor = [255, 235, 59]; // #FFEB3B
const redColor = [255, 82, 82];     // #FF5252

/**
 * cubicEase(t)
 * A small utility for a smoother LED brightness ramp-up/down.
 */
function cubicEase(t) {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * lerpColor(offColor, onColor, t)
 * Interpolates between offColor and onColor by a "cubic ease" factor of t.
 */
function lerpColor(offColor, onColor, t) {
  const eased = cubicEase(t);
  const r = Math.round(offColor[0] + (onColor[0] - offColor[0]) * eased);
  const g = Math.round(offColor[1] + (onColor[1] - offColor[1]) * eased);
  const b = Math.round(offColor[2] + (onColor[2] - offColor[2]) * eased);
  return `rgb(${r}, ${g}, ${b})`;
}

// --------------------------------------------------------------------
// Main UpperCompGUI Custom Element
// --------------------------------------------------------------------
class UpperCompGUI extends HTMLElement {
  constructor(patchConnection) {
    super();
    this.patchConnection = patchConnection;
    this.knobs = {};

    // Adjusted default meter values so GR starts at 0, not -6
    this.meters = {
      gainReduction: { value: 0, peak: 0 },
      inputLevel: { value: -36, peak: -36 },
      outputLevel: { value: -36, peak: -36 },
      // We'll track the post-saturation dB here
      postSat: { value: -36, peak: -36 }
    };
    this.decayRate = 0.5; // dB per frame

    // For waveform drawing
    this.waveformCanvas = null;
    this.ctx = null;
    this.gainReductionDb = 0;
    
    // For waveform history
    this.waveformHistory = [];
    this.historyLength = 30;
    this.historyUpdateRate = 1;
    this.frameCount = 0;
    this.currentThresholdDb = -28.0; // Default threshold value

    // Inject the HTML/CSS faceplate
    this.innerHTML = this.getHTML();
    this.animationFrameRequest = null;
  }

  getHTML() {
    // Generate 30 meter dots per meter for finer resolution
    const generateDots = () => '<div class="meter-dot"></div>'.repeat(30);
  
    return `
      <style>
      /* Import fonts */
      @import url('https://fonts.googleapis.com/css2?family=Audiowide&family=JetBrains+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');
  
      * {
        box-sizing: border-box;
      }
      upper-comp-gui {
        display: block;
        width: 1550px;
        height: 450px;
        overflow: hidden;
      }
      html, body {
        overflow: hidden;
        margin: 0;
        padding: 0;
      }
      body {
        background-color: #1a1a1a;
        font-family: 'Inter', sans-serif;
        color: #ccc;
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #compressor {
        position: relative;
        width: 100%;
        height: 100%;
        background: linear-gradient(145deg, #262626, #1e1e1e);
        border-radius: 12px;
        box-shadow:
          0 10px 30px rgba(0,0,0,0.8),
          inset 0 1px 1px rgba(255,255,255,0.1);
        overflow: hidden;
        padding: 20px;
      }
      .sections-container {
        display: flex;
        gap: 20px;
      }
      .knobs-section {
        display: flex;
        flex-direction: column;
        gap: 20px;
        padding: 10px;
        position: relative;
      }
      .knob-row {
        display: flex;
        gap: 25px; /* consistent spacing between each child */
        justify-content: center;
        flex-wrap: nowrap;
        /* Make this container relative so we can absolutely position the LED */
        position: relative;
      }
      .knob-wrapper {
        position: relative;
        width: 90px;
        text-align: center;
      }
      .knob {
        width: 65px;
        height: 65px;
        cursor: pointer;
        filter: brightness(0.85) contrast(1.2) drop-shadow(0 4px 8px rgba(0,0,0,0.8));
        transition: filter 0.2s ease;
      }
      .knob:hover {
        filter: brightness(1) contrast(1.3) drop-shadow(0 6px 12px rgba(0,0,0,0.9));
      }
      .knob-label {
        font-size: 11px;
        color: #bbb;
        margin-top: 8px;
        text-shadow: 0 1px 2px rgba(0,0,0,0.5);
        font-weight: 500;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .knob-value {
        font-size: 11px;
        color: #888;
        font-family: 'JetBrains Mono', monospace;
        margin-top: 4px;
        font-weight: 500;
      }
      .toggle-switches {
        display: flex;
        gap: 12px;
        align-items: center;
        margin-top: 10px;
        justify-content: center;
        flex-wrap: nowrap;
      }
      .toggle-button {
        padding: 6px 12px;
        border: none;
        background: #1a1a1a;
        color: #888;
        font-size: 11px;
        cursor: pointer;
        border-radius: 3px;
        transition: all 0.2s ease;
        font-weight: 500;
        letter-spacing: 0.5px;
        font-family: 'Inter', sans-serif;
        box-shadow:
          0 2px 4px rgba(0,0,0,0.4),
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
        padding: 10px;
      }
      .visualization-box {
        background: linear-gradient(to bottom, #1a1a1a, #222);
        border-radius: 8px;
        border: 1px solid #333;
        box-shadow: inset 0 0 20px rgba(0,0,0,0.4);
        width: 100%;
        height: 100%;
        padding: 10px;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
      }
      #title {
        font-family: 'Audiowide', sans-serif;
        font-size: 24px;
        color: #ddd;
        text-align: center;
        margin: 0;
        margin-bottom: 10px;
        text-shadow: 0 0 10px rgba(76,175,80,0.3);
        letter-spacing: 4px;
      }
      #waveform {
        width: 100%;
        height: 100%;
      }
      .meters-section {
        display: flex;
        flex-direction: column;
        gap: 20px;
        padding: 10px;
        margin-top: -20px;
        position: relative; /* so we can absolutely position .logo-container */
      }
      .meter-block {
        position: relative;
        display: flex;
        flex-direction: column;
        margin-bottom: 8px;
      }
      .meter-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .meter-label {
        font-size: 11px;
        color: #bbb;
        font-weight: 500;
        letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .meter-value {
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
        color: #888;
        font-weight: 500;
      }
      .meter-dots {
        display: flex;
        flex-direction: row;
        gap: 4px;
        padding: 4px;
        background: rgba(0,0,0,0.2);
        border-radius: 4px;
        box-shadow: inset 0 1px 3px rgba(0,0,0,0.3);
        position: relative;
        height: 20px;
      }
      .meter-dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #333;
        border: 1px solid #222;
        box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);
      }
      .meter-scale {
        position: absolute;
        left: 4px;
        right: 4px;
        bottom: -20px;
        height: 16px;
        pointer-events: none;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .scale-marker {
        position: absolute;
        color: #999;
        font-size: 10px;
        font-family: 'JetBrains Mono', monospace;
        font-weight: 500;
        white-space: nowrap;
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
        bottom: 10px; 
        left: 50%;
        transform: translateX(-50%);
        opacity: 0.85;
        transition: opacity 0.2s ease;
      }
      .logo-container:hover {
        opacity: 1.0;
      }
      .secret-weapon-logo {
        width: 180px;
        height: auto;
      }

      /* -------------------------------------------------------------- */
      /* LED styling changes:
         - Remove the transition so the LED turns bright immediately.
         - #saturationLedWrapper is absolutely positioned (its position is set via JS).
      /* -------------------------------------------------------------- */
      #saturationLed {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background-color: #444;
        /* Removed transition for immediate brightness */
      }
      #saturationLed.on {
        background-color: #FF0000; /* bright red */
        box-shadow: 0 0 12px 4px rgba(255, 0, 0, 1.0);
      }
      #saturationLedWrapper {
        position: absolute;
        width: 30px; /* container width (can be adjusted as needed) */
        height: 14px;
        pointer-events: none;
      }
      </style>
      
      <div id="compressor">
        <div class="sections-container">
          <!-- Knobs Section -->
          <div class="knobs-section">
            <!-- Row 1: 5 knobs (Saturation, Saturation Mix, Comp In Gain, Ratio, Threshold) -->
            <div class="knob-row" id="firstKnobRow">
              <!-- Saturation (drive) -->
              <div class="knob-wrapper" id="satWrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="drive" data-min="0.1" data-max="10" data-value="1.0">
                <div class="knob-label">Saturation</div>
                <div class="knob-value">0.9</div>
              </div>
  
              <!-- Saturation Mix (satMixIn) -->
              <div class="knob-wrapper" id="satMixWrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="satMixIn" data-min="0" data-max="1" data-value="1.0">
                <div class="knob-label">Saturation Mix</div>
                <div class="knob-value">1.0</div>
              </div>
  
              <!-- Comp In Gain (inputGainIn) -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="inputGainIn" data-min="-25" data-max="25" data-value="0.0">
                <div class="knob-label">Comp In Gain</div>
                <div class="knob-value">0.0 dB</div>
              </div>
  
              <!-- Ratio (ratioIn) -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="ratioIn" data-min="1" data-max="10" data-value="4.0">
                <div class="knob-label">Ratio</div>
                <div class="knob-value">4.0:1</div>
              </div>
  
              <!-- Threshold (thresholdDbIn) -->
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="thresholdDbIn" data-min="-60" data-max="0" data-value="-28.0">
                <div class="knob-label">Threshold</div>
                <div class="knob-value">-28.0 dB</div>
              </div>
            </div>
            
            <!-- The LED is now removed from the flex flow and placed as an absolutely positioned element -->
            <div id="saturationLedWrapper" class="led-wrapper">
              <div id="saturationLed"></div>
            </div>
            
            <!-- Row 2: 5 knobs (Lookahead, Attack, Release, Output Gain, Sidechain Freq) -->
            <div class="knob-row">
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="lookaheadMsIn" data-min="0" data-max="50" data-value="5.0">
                <div class="knob-label">Lookahead</div>
                <div class="knob-value">5.0 ms</div>
              </div>
  
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="attackMsIn" data-min="1" data-max="100" data-value="25.0">
                <div class="knob-label">Attack</div>
                <div class="knob-value">25.0 ms</div>
              </div>
              
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="releaseMsIn" data-min="10" data-max="500" data-value="80.0">
                <div class="knob-label">Release</div>
                <div class="knob-value">80.0 ms</div>
              </div>
  
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="outputGainIn" data-min="-25" data-max="25" data-value="0.0">
                <div class="knob-label">Output Gain</div>
                <div class="knob-value">0.0 dB</div>
              </div>
              
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="sidechainFreqIn" data-min="20" data-max="20000" data-value="200.0">
                <div class="knob-label">Sidechain Freq</div>
                <div class="knob-value">200.0 Hz</div>
              </div>
            </div>
            
            <!-- Row 3: Toggles + Comp Mix remain as before -->
            <div class="toggle-switches">
              <button class="toggle-button" data-param="enableLookAheadIn">LOOKAHEAD ENABLED</button>
              
              <div class="knob-wrapper">
                <img class="knob"
                     src="https://rawcdn.githack.com/gabefryaudio/Uppercomp/5713865c79c7a4a9bc8104ef1957cba3a2d41046/White%20Knob.svg"
                     data-param="compMixIn" data-min="0" data-max="1" data-value="1.0">
                <div class="knob-label">Comp Mix</div>
                <div class="knob-value">1.0</div>
              </div>
              
              <button class="toggle-button" data-param="sidechainFilterEnableIn">SIDECHAIN FILTER ENABLED</button>
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
            <!-- Input Meter -->
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Input Level</span>
                <span class="meter-value">-36.0 dB</span>
              </div>
              <div class="meter-dots" id="inputMeter">
                ${generateDots()}
              </div>
              <div class="meter-scale" id="inputMeterScale"></div>
            </div>
            
            <!-- Gain Reduction Meter -->
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Gain Reduction</span>
                <span class="meter-value">0.0 dB</span>
              </div>
              <div class="meter-dots" id="grMeter">
                ${generateDots()}
              </div>
              <div class="meter-scale" id="grMeterScale"></div>
            </div>
            
            <!-- Output Meter -->
            <div class="meter-block">
              <div class="meter-header">
                <span class="meter-label">Output Level</span>
                <span class="meter-value">-36.0 dB</span>
              </div>
              <div class="meter-dots" id="outputMeter">
                ${generateDots()}
              </div>
              <div class="meter-scale" id="outputMeterScale"></div>
            </div>
  
            <!-- Logo container now placed at the end of .meters-section -->
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
  
  connectedCallback() {
    this.initializeKnobs();
    this.initializeWaveform();
    this.setupPatchListeners();

    this.querySelectorAll('.toggle-button').forEach(button => {
      const param = button.dataset.param;
      button.addEventListener('click', () => {
        const newState = !button.classList.contains('active');
        button.classList.toggle('active', newState);
        this.patchConnection.sendEventOrValue(param, newState);
      });
    });

    // Request initial values
    Object.keys(this.knobs).forEach(param => {
      this.patchConnection.requestParameterValue(param);
    });
    this.patchConnection.requestParameterValue('enableLookAheadIn');
    this.patchConnection.requestParameterValue('sidechainFilterEnableIn');

    // Initialize the meter marker LEDs, then place scale labels
    this.initializeMetersWithMarkers();

    // Position the LED between the Saturation and Saturation Mix knobs
    this.positionSaturationLed();
    // Update LED position on window resize for responsiveness
    window.addEventListener('resize', () => this.positionSaturationLed());

    // Prevent text selection in the entire component
    this.style.userSelect = 'none';
    this.style.webkitUserSelect = 'none';
    this.style.msUserSelect = 'none';

    // Prevent text selection during drag operations
    this.addEventListener('mousedown', (e) => {
      const target = e.target;
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        e.preventDefault();
      }
    });

    this.addEventListener('selectstart', (e) => {
      const target = e.target;
      if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        return false;
      }
    });

    // Append a global style element to enforce non-selectability, while allowing selection for interactive elements.
    const nonSelectableStyle = document.createElement('style');
    nonSelectableStyle.textContent = `
      * {
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
      }
      .knob, .toggle-button {
        user-select: auto;
        -webkit-user-select: auto;
        -moz-user-select: auto;
        -ms-user-select: auto;
      }
    `;
    this.appendChild(nonSelectableStyle);

    // Kick off the animation loop
    this.animationFrameRequest = requestAnimationFrame(() => this.animate());
  }

  disconnectedCallback() {
    if (this.animationFrameRequest) {
      cancelAnimationFrame(this.animationFrameRequest);
    }
    if (this.paramListener) {
      this.patchConnection.removeAllParameterListener(this.paramListener);
    }
    if (this.gainReductionListener) {
      this.patchConnection.removeEndpointListener('gainReduction', this.gainReductionListener);
    }
    if (this.inputMeterListener) {
      this.patchConnection.removeEndpointListener('inputMeter', this.inputMeterListener);
    }
    if (this.outputMeterListener) {
      this.patchConnection.removeEndpointListener('outputMeter', this.outputMeterListener);
    }
    // If you added a postSatMeter listener, remove it here too:
    // this.patchConnection.removeEndpointListener('postSatMeter', this.postSatListener);
  }

  // ------------------------------------------------------------------
  // Setup Patch Listeners
  // ------------------------------------------------------------------
  setupPatchListeners() {
    this.paramListener = (event) => {
      const { endpointID, value } = event;
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

    // GainReduction listener
    this.patchConnection.addEndpointListener('gainReduction', (value) => {
      this.meters.gainReduction.value = value;
    });
    this.patchConnection.addEndpointListener('inputMeter', (value) => {
      this.meters.inputLevel.value = value;
    });
    this.patchConnection.addEndpointListener('outputMeter', (value) => {
      // Add a 6 dB offset to match the DAW meter
      this.meters.outputLevel.value = value + 5.6;
    });

    this.patchConnection.addEndpointListener('postSatMeter', (value) => {
      console.log('postSat dB:', value);
      const led = this.querySelector('#saturationLed');
      // Use a threshold of -17 dB (adjust as needed for your application)
      const ledThreshold = 8.0;
      if (led) {
        if (value >= ledThreshold) {
          led.classList.add('on'); // LED is hard on
        } else {
          led.classList.remove('on'); // LED is hard off
        }
      }
    });
    
    this.patchConnection.addEndpointListener('enableLookAheadIn', (value) => {
      const btn = this.querySelector('.toggle-button[data-param="enableLookAheadIn"]');
      if (btn) {
        btn.classList.toggle('active', value);
      }
    });
    this.patchConnection.addEndpointListener('sidechainFilterEnableIn', (value) => {
      const btn = this.querySelector('.toggle-button[data-param="sidechainFilterEnableIn"]');
      if (btn) {
        btn.classList.toggle('active', value);
      }
    });
  }

  // ------------------------------------------------------------------
  // Knob Initialization & Interaction
  // ------------------------------------------------------------------
  // Add double-click to reset functionality to initializeKnobs
  initializeKnobs() {
    this.knobs = {};
    const knobEls = this.querySelectorAll('.knob');
    knobEls.forEach(knobEl => {
      const param = knobEl.dataset.param;
      const minVal = parseFloat(knobEl.dataset.min);
      const maxVal = parseFloat(knobEl.dataset.max);
      const initVal = parseFloat(knobEl.dataset.value);
      const defaultVal = parseFloat(knobEl.dataset.default || knobEl.dataset.value);
      
      this.knobs[param] = {
        element: knobEl,
        currentValue: initVal,
        targetValue: initVal,
        min: minVal,
        max: maxVal,
        default: defaultVal, // Store default value
        isDragging: false,
        lastY: 0
      };
      this.updateKnobRotation(param, initVal);
      this.updateKnobDisplayValue(param, initVal);
      
      // Add double-click event for reset
      knobEl.addEventListener('dblclick', () => this.resetKnobToDefault(param));
    });
    this.setupKnobDragEvents();
  }

  // Add the reset function
  resetKnobToDefault(param) {
    const knob = this.knobs[param];
    knob.targetValue = knob.default;
    knob.currentValue = knob.default;
    this.updateKnobRotation(param, knob.default);
    this.updateKnobDisplayValue(param, knob.default);
    this.patchConnection.sendEventOrValue(param, knob.default);
    
    // If it's the threshold knob, update the waveform
    if (param === 'thresholdDbIn') {
      this.currentThresholdDb = knob.default;
      this.drawWaveform();
    }
  }

  setupKnobDragEvents() {
    const knobEls = this.querySelectorAll('.knob');
    knobEls.forEach(knobEl => {
      knobEl.addEventListener('mousedown', (e) => this.startKnobDrag(e, knobEl.dataset.param));
      knobEl.addEventListener('touchstart', (e) => this.startKnobTouch(e, knobEl.dataset.param), { passive: false });
    });
    document.addEventListener('mousemove', (e) => this.handleKnobDrag(e));
    document.addEventListener('mouseup', () => this.stopKnobDrag());
    document.addEventListener('touchmove', (e) => this.handleKnobTouch(e), { passive: false });
    document.addEventListener('touchend', () => this.stopKnobDrag());
  }

  startKnobDrag(e, param) {
    e.preventDefault();
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY = e.clientY;
  }

  startKnobTouch(e, param) {
    e.preventDefault();
    this.knobs[param].isDragging = true;
    this.knobs[param].lastY = e.touches[0].clientY;
  }

  handleKnobDrag(e) {
    e.preventDefault(); // Prevent default dragging behavior and text selection
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging) {
        const deltaY = e.clientY - knob.lastY;
        knob.lastY = e.clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });
  }

  handleKnobTouch(e) {
    e.preventDefault();
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      if (knob.isDragging && e.touches.length) {
        const deltaY = e.touches[0].clientY - knob.lastY;
        knob.lastY = e.touches[0].clientY;
        this.adjustKnobValue(param, deltaY);
      }
    });
  }

  stopKnobDrag() {
    Object.keys(this.knobs).forEach(param => {
      this.knobs[param].isDragging = false;
    });
  }

  // Modify the adjustKnobValue function to use shift for precision
  adjustKnobValue(param, deltaY) {
    const knob = this.knobs[param];
    const range = knob.max - knob.min;
    
    // Increase base sensitivity (from 0.3 to 0.5)
    const baseSensitivity = 1.0;
    
    // Use a lower sensitivity when shift is pressed
    const sensitivity = this.isShiftDown ? baseSensitivity * 0.1 : baseSensitivity;
    
    const valueChange = (deltaY * sensitivity * range) / 100;
    knob.targetValue = Math.min(knob.max, Math.max(knob.min, knob.targetValue - valueChange));
  }


  updateKnobRotation(param, value) {
    const knob = this.knobs[param];
    const range = knob.max - knob.min;
    const pct = (value - knob.min) / range;
    const degrees = pct * 270 - 135; // 270-degree sweep, offset by -135
    knob.element.style.transform = `rotate(${degrees}deg)`;
  }

  updateKnobDisplayValue(param, value) {
    const knob = this.knobs[param];
    const label = knob.element.parentElement.querySelector('.knob-value');
    if (!label) return;
    let displayValue = '';
    switch (param) {
      case 'drive':
        displayValue = value.toFixed(1);
        break;
      case 'satMixIn':
        displayValue = value.toFixed(2);
        break;
      case 'ratioIn':
        displayValue = `${value.toFixed(1)}:1`;
        break;
      case 'thresholdDbIn':
        displayValue = `${value >= 0 ? '+' : ''}${value.toFixed(1)} dB`;
        break;
      case 'lookaheadMsIn':
      case 'attackMsIn':
      case 'releaseMsIn':
        displayValue = `${value.toFixed(1)} ms`;
        break;
      case 'inputGainIn':
      case 'outputGainIn':
        displayValue = `${value.toFixed(2)} dB`;
        break;
      case 'sidechainFreqIn':
        displayValue = `${value.toFixed(1)} Hz`;
        break;
      case 'compMixIn':
        displayValue = value.toFixed(2);
        break;
      default:
        displayValue = value.toFixed(1);
    }
    label.textContent = displayValue;
  }

  // ------------------------------------------------------------------
  // Waveform Visualization
  // ------------------------------------------------------------------
  initializeWaveform() {
    this.waveformCanvas = this.querySelector('#waveform');
    if (!this.waveformCanvas) return;
    const rect = this.waveformCanvas.getBoundingClientRect();
    this.waveformCanvas.width = rect.width;
    this.waveformCanvas.height = rect.height;
    this.ctx = this.waveformCanvas.getContext('2d');
    this.ctx.fillStyle = '#444';
    this.ctx.fillRect(0, 0, rect.width, rect.height);
  }

  drawWaveform() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const w = this.waveformCanvas.width;
    const h = this.waveformCanvas.height;
    
    // Clear canvas with a dark background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);
    
    // Draw grid lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    
    // Horizontal grid lines (dB levels)
    const dbLevels = [-60, -48, -36, -24, -12, 0, 12];
    dbLevels.forEach(dbLevel => {
      const y = this.dbToY(dbLevel, h);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillStyle = '#666';
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(`${dbLevel} dB`, w - 5, y - 5);
    });
    
    // Vertical grid lines (time divisions)
    const timeDiv = 5;
    for (let i = 1; i < timeDiv; i++) {
      const x = w * (i / timeDiv);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    
    // Draw the pre-compression input as green bars
    if (this.waveformHistory.length > 0) {
      const barWidth = w / this.historyLength;
      ctx.fillStyle = '#4CAF50';
      this.waveformHistory.forEach((sample, index) => {
        const x = index * barWidth;
        const inputLevel = sample.inputLevel;
        const inputY = this.dbToY(inputLevel, h);
        const barHeight = h - inputY;
        if (barHeight > 0) {
          ctx.fillRect(x, inputY, barWidth - 1, barHeight);
        }
      });
    }
    
    // Draw threshold line
    const thresholdY = this.dbToY(this.currentThresholdDb, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(0, thresholdY);
    ctx.lineTo(w, thresholdY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`Threshold: ${this.currentThresholdDb.toFixed(1)} dB`, 10, thresholdY - 5);
  }

  dbToY(db, height) {
    const minDb = -60;
    const maxDb = 12;
    const dbRange = maxDb - minDb;
    const clampedDb = Math.max(minDb, Math.min(maxDb, db));
    const normalized = (clampedDb - minDb) / dbRange;
    return height * (1 - normalized);
  }

  // ------------------------------------------------------------------
  // Meter Initialization with Markers
  // ------------------------------------------------------------------
  initializeMetersWithMarkers() {
    // Directly map each 6 dB marker to the nearest dot, avoiding skip issues.
    this.initializeMeterWithMarkers('inputMeter', inputOutputDbMarkers, -36, 6, false);
    this.initializeMeterWithMarkers('outputMeter', inputOutputDbMarkers, -36, 6, false);
    this.initializeMeterWithMarkers('grMeter', gainReductionDbMarkers, 0, -36, true);

    // Then place scale labels for each meter
    this.positionAllScaleMarkers();
  }

  initializeMeterWithMarkers(meterId, markers, minDb, maxDb, isReversed) {
    const meterElement = this.querySelector(`#${meterId}`);
    if (!meterElement) return;

    const dots = meterElement.querySelectorAll('.meter-dot');
    const totalDots = dots.length;
    const range = Math.abs(maxDb - minDb);

    // Map each marker to the dot index i = round(fraction * (totalDots - 1))
    const markerAssignments = markers.map(marker => {
      const fraction = isReversed
        ? (minDb - marker) / range
        : (marker - minDb) / range;
      const i = Math.round(Math.max(0, Math.min(1, fraction)) * (totalDots - 1));
      return { marker, i };
    });

    // Assign .marker-led to each chosen dot
    markerAssignments.forEach(({ marker, i }) => {
      const dot = dots[i];
      dot.classList.add('marker-led');
      dot.dataset.dbValue = marker;
    });
  }

  positionAllScaleMarkers() {
    this.positionMeterScale('inputMeterScale', 'inputMeter', inputOutputDbMarkers, -36, 6);
    this.positionMeterScale('grMeterScale', 'grMeter', gainReductionDbMarkers, 0, -36);
    this.positionMeterScale('outputMeterScale', 'outputMeter', inputOutputDbMarkers, -36, 6);
  }

  positionMeterScale(scaleID, dotsID, markers, minDb, maxDb) {
    const scaleContainer = this.querySelector(`#${scaleID}`);
    const dotsContainer = this.querySelector(`#${dotsID}`);
    if (!scaleContainer || !dotsContainer) return;

    scaleContainer.innerHTML = '';

    // We have 30 dots, each effectively 16px wide (12px + 4px gap).
    const totalDots = 30;
    const stepWidth = 16;
    const range = Math.abs(maxDb - minDb);

    // Offset so the label is visually centered under the dot
    const dotCenterOffset = 4 + 6; // (left padding) + (dot width/2)

    markers.forEach(dbVal => {
      // Compute fraction in [0..1]
      const fraction = minDb < maxDb
        ? (dbVal - minDb) / range
        : (minDb - dbVal) / range;
      const clippedFraction = Math.max(0, Math.min(1, fraction));
      
      // Dot index
      const i = Math.round(clippedFraction * (totalDots - 1));

      // Create label
      const label = document.createElement('div');
      label.classList.add('scale-marker');
      label.textContent = (dbVal > 0) ? `+${dbVal} dB` : `${dbVal} dB`;

      // Position it
      const leftPx = dotCenterOffset + i * stepWidth;
      label.style.left = `${leftPx}px`;

      scaleContainer.appendChild(label);
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
      // Calculate the gap between the right edge of the Saturation knob and left edge of Saturation Mix knob.
      // The LED's center should be at (satRect.right + half the gap) relative to the container.
      const gap = satMixRect.left - satRect.right;
      const ledCenterX = satRect.right + gap / 2;
      const leftPos = ledCenterX - containerRect.left - (ledWrapper.offsetWidth / 2);
      // Vertically, center with the knobs (we assume both knobs have similar height)
      const topPos = satRect.top - containerRect.top + (satRect.height / 2) - (ledWrapper.offsetHeight / 2);
      ledWrapper.style.left = `${leftPos}px`;
      ledWrapper.style.top = `${topPos}px`;
    }
  }

  // ------------------------------------------------------------------
  // Animation Loop / Meters Update
  // ------------------------------------------------------------------
  animate() {
    // If input level is very low (no audio), force gain reduction to zero.
    if (this.meters.inputLevel.value < -50) {
      this.meters.gainReduction.value = 0;
      this.meters.gainReduction.peak = 0;
    }

    // Decay peaks for input and output
    this.meters.inputLevel.peak = Math.max(
      this.meters.inputLevel.value,
      this.meters.inputLevel.peak - this.decayRate
    );
    this.meters.outputLevel.peak = Math.max(
      this.meters.outputLevel.value,
      this.meters.outputLevel.peak - this.decayRate
    );

    // Modified gain reduction handling:
    // If the current gain reduction value is very close to zero, decay more aggressively.
    if (Math.abs(this.meters.gainReduction.value) < 0.05) {
      this.meters.gainReduction.peak = 0;
      this.meters.gainReduction.value = 0; // Force exact zero
    } else {
      // Normal tracking behavior for actual compression
      this.meters.gainReduction.peak = this.meters.gainReduction.value;
    }

    // Smooth knob movement
    Object.keys(this.knobs).forEach(param => {
      const knob = this.knobs[param];
      const diff = knob.targetValue - knob.currentValue;
      if (Math.abs(diff) > 0.0001) {
        const smoothingFactor = 0.2;
        knob.currentValue += diff * smoothingFactor;
        this.updateKnobRotation(param, knob.currentValue);
        this.updateKnobDisplayValue(param, knob.currentValue);
        this.patchConnection.sendEventOrValue(param, knob.currentValue);

        if (param === 'thresholdDbIn') {
          this.currentThresholdDb = knob.currentValue;
        }
      }
    });

    // Keep short history of levels for the waveform
    this.gainReductionDb = this.meters.gainReduction.value;
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

    // Draw the waveform and update meters
    this.drawWaveform();
    this.updateMeters();

    // Request the next animation frame
    this.animationFrameRequest = requestAnimationFrame(() => this.animate());
  }

  /**
   * updateMeters()
   * - Ensures that if gain reduction is near zero, no LEDs light up on the GR meter.
   */
  updateMeters() {
    const meterMapping = {
      inputLevel: {
        id: 'inputMeter',
        minDb: -36,
        maxDb: 6,
        ascending: true
      },
      gainReduction: {
        id: 'grMeter',
        minDb: 0,
        maxDb: -36,
        ascending: false
      },
      outputLevel: {
        id: 'outputMeter',
        minDb: -36,
        maxDb: 6,
        ascending: true
      }
    };

    Object.keys(meterMapping).forEach(param => {
      const config = meterMapping[param];
      const container = this.querySelector(`#${config.id}`);
      if (!container) return;

      const dots = container.querySelectorAll('.meter-dot');
      const valueEl = container.parentElement.querySelector('.meter-value');
      const value = this.meters[param].peak;

      // For gainReduction, explicitly force small values to exactly zero.
      let displayValue = value;
      if (param === 'gainReduction' && Math.abs(value) < 0.05) {
        displayValue = 0.0;
      }

      // Update numeric readout
      if (valueEl) {
        valueEl.textContent = `${displayValue.toFixed(1)} dB`;
      }

      // For meter calculations, use the cleaned value
      const meterValue = (param === 'gainReduction' && Math.abs(value) < 0.05) ? 0.0 : value;

      const totalDots = dots.length;
      const range = Math.abs(config.maxDb - config.minDb);
      const dbPerDot = range / (totalDots - 1);

      for (let i = 0; i < totalDots; i++) {
        const dotDb = config.ascending
          ? config.minDb + i * dbPerDot
          : config.minDb - i * dbPerDot;

        let intensity;
        if (config.ascending) {
          // Ascending meter (e.g., -36 -> +6)
          if (meterValue >= dotDb) {
            intensity = 1.0;
          } else if (meterValue < dotDb - dbPerDot) {
            intensity = 0.0;
          } else {
            intensity = (meterValue - (dotDb - dbPerDot)) / dbPerDot;
          }
        } else {
          // Descending meter (0 -> -36)
          const clampedValue = Math.min(0, meterValue);
          if (clampedValue >= -0.01) {
            intensity = 0.0;
          } else if (clampedValue <= dotDb) {
            intensity = 1.0;
          } else if (clampedValue > dotDb + dbPerDot) {
            intensity = 0.0;
          } else {
            intensity = (dotDb + dbPerDot - clampedValue) / dbPerDot;
          }
        }

        intensity = Math.max(0.0, Math.min(1.0, intensity));

        // Choose color
        let activeColor =
          param === 'gainReduction'
            ? redColor
            : (dotDb < -12 ? greenColor : (dotDb < 0 ? yellowColor : redColor));

        // Interpolate color
        const color = lerpColor(offColor, activeColor, intensity);
        dots[i].style.background = color;

        // Toggle 'active' class
        dots[i].classList.toggle('active', intensity > 0);

        // Marker dots get a small glow if > 0.5 lit
        dots[i].style.boxShadow =
          dots[i].classList.contains('marker-led') && intensity > 0.5
            ? '0 0 4px rgba(255,255,255,0.3)'
            : 'none';
      }
    });
  }

}

// Register the custom element
customElements.define('upper-comp-gui', UpperCompGUI);

/**
 * createPatchView(patchConnection)
 * Exports a factory function that instantiates the custom element.
 */
export default function createPatchView(patchConnection) {
  return new UpperCompGUI(patchConnection);
}
