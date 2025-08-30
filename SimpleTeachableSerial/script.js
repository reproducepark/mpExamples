const MODEL_URL = "https://teachablemachine.withgoogle.com/models/0eNpRibO2/";

// Teachable state
let model = null;
let maxPredictions = 0;
let webcam = null; // not used; we draw <video> into <canvas>
let mediaStream = null;
let isRunning = false;

// DOM: video/canvas
const videoElement = document.querySelector('.input-video');
const canvasElement = document.querySelector('.output-canvas');
const canvasCtx = canvasElement.getContext('2d');
// DOM: controls
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
// DOM: info
const statusElement = document.getElementById('status');
const serialStatusElement = document.getElementById('serialStatus');
const lastSentElement = document.getElementById('lastSent');
// DOM: predictions container
const predictionsContainer = document.getElementById('predictions');

// Serial state
let port = null;
let writer = null;
let reader = null;
let readLoopAbortController = null;

// Track last top class we sent to avoid redundant serial writes
let lastTopClass = null;

async function loadModel() {
  const modelURL = MODEL_URL + "model.json";
  const metadataURL = MODEL_URL + "metadata.json";
  model = await window.tmImage.load(modelURL, metadataURL);
  maxPredictions = model.getTotalClasses();
}

function buildPredictionRows() {
  predictionsContainer.innerHTML = "";
  for (let i = 0; i < maxPredictions; i += 1) {
    const row = document.createElement('div');
    row.className = 'prediction-row';

    const label = document.createElement('div');
    label.className = 'prediction-label';
    label.textContent = '-';

    const bar = document.createElement('div');
    bar.className = 'prediction-bar';
    const barFill = document.createElement('div');
    barFill.className = 'prediction-bar-fill';
    bar.appendChild(barFill);

    const score = document.createElement('div');
    score.className = 'prediction-score';
    score.textContent = '0.00';

    row.appendChild(label);
    row.appendChild(bar);
    row.appendChild(score);
    predictionsContainer.appendChild(row);
  }
}

function updatePredictionRows(prediction) {
  const rows = predictionsContainer.querySelectorAll('.prediction-row');
  for (let i = 0; i < prediction.length; i += 1) {
    const { className, probability } = prediction[i];
    const row = rows[i];
    const label = row.querySelector('.prediction-label');
    const barFill = row.querySelector('.prediction-bar-fill');
    const score = row.querySelector('.prediction-score');
    label.textContent = className;
    const pct = Math.round(probability * 100);
    barFill.style.width = `${pct}%`;
    score.textContent = probability.toFixed(2);
  }
}

function drawVideoToCanvas() {
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
}

async function predictLoop() {
  if (!isRunning) return;
  drawVideoToCanvas();
  const prediction = await model.predict(canvasElement);
  updatePredictionRows(prediction);

  // Determine top class
  let top = null;
  for (const p of prediction) {
    if (!top || p.probability > top.probability) top = p;
  }
  if (top) {
    maybeSendTopClass(top);
  }

  window.requestAnimationFrame(predictLoop);
}

async function start() {
  try {
    startButton.disabled = true;
    statusElement.textContent = '모델 로딩 중...';
    if (!model) {
      await loadModel();
    }
    statusElement.textContent = '카메라 접근 중...';
    mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    videoElement.srcObject = mediaStream;
    await videoElement.play();

    canvasElement.width = videoElement.videoWidth || 640;
    canvasElement.height = videoElement.videoHeight || 480;

    buildPredictionRows();
    statusElement.textContent = '실행 중입니다. 예측 결과 및 시리얼 전송 상태를 확인하세요.';
    statusElement.innerHTML += ' <span class="loading"></span>';

    isRunning = true;
    stopButton.disabled = false;
    window.requestAnimationFrame(predictLoop);
  } catch (err) {
    console.error(err);
    statusElement.textContent = '시작 실패: 브라우저 권한 또는 환경을 확인하세요.';
    startButton.disabled = false;
  }
}

function stop() {
  isRunning = false;
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  stopButton.disabled = true;
  startButton.disabled = false;
  statusElement.textContent = '카메라를 시작하려면 버튼을 클릭하세요.';
  lastTopClass = null;
}

// Serial helpers
function updateSerialUI(connected) {
  const connectButton = document.getElementById('connectButton');
  const disconnectButton = document.getElementById('disconnectButton');
  connectButton.disabled = connected;
  disconnectButton.disabled = !connected;
  serialStatusElement.textContent = connected ? '시리얼: 연결됨 (9600 bps)' : '시리얼: 연결되지 않음';
}

async function connectSerial() {
  if (!('serial' in navigator)) {
    alert('이 브라우저는 Web Serial API를 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.');
    return;
  }
  try {
    serialStatusElement.textContent = '시리얼: 포트 선택 대기 중...';
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    writer = port.writable.getWriter();
    readLoopAbortController = new AbortController();
    startReadLoop(readLoopAbortController.signal);
    updateSerialUI(true);
  } catch (err) {
    console.error(err);
    serialStatusElement.textContent = '시리얼: 연결 실패 - ' + err.message;
  }
}

async function startReadLoop(abortSignal) {
  try {
    reader = port.readable.getReader();
    const decoder = new TextDecoder();
    while (!abortSignal.aborted) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      console.log('[Serial RX]', decoder.decode(value));
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.error('Read error:', err);
  } finally {
    try { reader?.releaseLock(); } catch (_) {}
  }
}

async function sendSerialLine(line) {
  if (!writer || !port) return;
  try {
    const encoded = new TextEncoder().encode(line + '\r\n');
    await writer.write(encoded);
    lastSentElement.textContent = `마지막 전송: ${line}`;
    console.log('[Serial TX]', line);
  } catch (err) {
    console.error('Write error:', err);
  }
}

function maybeSendTopClass(top) {
  if (!top) return;
  const line = `${top.className},${top.probability.toFixed(2)}`;
  if (lastTopClass === line) return; // avoid redundant sends
  lastTopClass = line;
  sendSerialLine(line);
}

async function disconnectSerial() {
  try {
    readLoopAbortController?.abort();
    try { reader?.cancel(); } catch (_) {}
    try { reader?.releaseLock(); } catch (_) {}
    try { writer?.releaseLock(); } catch (_) {}
    await port?.close();
  } catch (err) {
    console.error('Disconnect error:', err);
  } finally {
    reader = null; writer = null; port = null;
    updateSerialUI(false);
  }
}

// Event bindings
document.getElementById('connectButton').addEventListener('click', connectSerial);
document.getElementById('disconnectButton').addEventListener('click', disconnectSerial);
startButton.addEventListener('click', start);
stopButton.addEventListener('click', stop);

// Init: draw initial message
window.addEventListener('load', () => {
  canvasElement.width = 1280;
  canvasElement.height = 720;
  canvasCtx.fillStyle = '#f5f5f5';
  canvasCtx.fillRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.font = '30px Arial';
  canvasCtx.fillStyle = '#000000';
  canvasCtx.textAlign = 'center';
  canvasCtx.fillText('카메라를 시작하여 예측/전송을 확인하세요', canvasElement.width / 2, canvasElement.height / 2);
  updateSerialUI(false);
});


