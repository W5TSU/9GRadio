import { Scanner, type RadioHandle } from './app/scanner';
import { h } from './ui/dom';
import { HitList } from './ui/hitList';
import { NowPlaying } from './ui/nowPlaying';
import { PacketsPanel } from './ui/packetsPanel';
import { RadioPanel } from './ui/radioPanel';

const WATERFALL_INTERVAL_MS = 100;

function notice(...children: (string | Node)[]) {
  return h('div', { class: 'box notice' }, ...children);
}

async function boot() {
  const app = document.getElementById('app')!;
  const scanner = await Scanner.open();

  const message = h('div', { class: 'box notice' });
  message.hidden = true;
  const showMessage = (text: string) => {
    message.textContent = text;
    message.hidden = !text;
  };

  const addRadio = h('button', { class: 'primary', disabled: !scanner.hasUsb }, '+ Add radio');
  addRadio.onclick = () => {
    showMessage('');
    scanner.chooseRadio().catch((e: Error) => showMessage(e.message));
  };
  const startAll = h('button', { onclick: () => toggleAll() }, 'Start all');
  const mute = h('button', {
    onclick: () => {
      scanner.audio.setMuted(!scanner.audio.isMuted);
      mute.textContent = scanner.audio.isMuted ? 'Unmute' : 'Mute';
    },
  }, 'Mute');
  const volume = h('input', { type: 'range', min: '0', max: '100', value: '80', title: 'Volume' });
  volume.oninput = () => scanner.audio.setVolume(Number(volume.value) / 100);

  const topbar = h(
    'header',
    { class: 'topbar' },
    h('h1', null, '9GRadio Web Scanner'),
    addRadio,
    h('button', { title: 'Try the scanner on simulated signals', onclick: () => scanner.addDemo() }, '+ Demo radio'),
    startAll,
    h('span', { class: 'spacer' }),
    mute,
    volume,
  );

  const nowPlaying = new NowPlaying(scanner);
  const packets = new PacketsPanel(scanner);
  const hitList = new HitList(scanner, (row) => void packets.show(row));
  const panelsBox = h('div', { class: 'left' });
  const panels = new Map<string, RadioPanel>();
  panelsBox.append(packets.element);

  app.append(topbar);
  if (!scanner.hasUsb) {
    app.append(notice('This browser has no WebUSB, so it can\'t reach a radio. Use Chrome or Edge. The demo radio still works here.'));
  } else if (!window.isSecureContext) {
    app.append(notice('Radios only work from https:// or localhost.'));
  }
  app.append(message, nowPlaying.element, h('div', { class: 'columns' }, panelsBox, hitList.element));

  const ready = () => [...scanner.radios.values()].filter((r) => r.info);
  function toggleAll() {
    const radios = ready();
    const anyRunning = radios.some((r) => r.running);
    for (const r of radios) {
      if (anyRunning) {
        if (r.running) scanner.stop(r);
      } else if (!r.error) {
        scanner.start(r);
      }
    }
  }

  let renderQueued = false;
  const render = () => {
    renderQueued = false;
    for (const handle of scanner.radios.values()) {
      if (!panels.has(handle.id)) addPanel(handle);
    }
    for (const [id, panel] of panels) {
      if (!scanner.radios.has(id)) {
        panel.element.remove();
        panels.delete(id);
      } else {
        panel.render();
      }
    }
    startAll.textContent = ready().some((r) => r.running) ? 'Stop all' : 'Start all';
    startAll.disabled = ready().length === 0;
    nowPlaying.render();
    hitList.render();
  };
  const addPanel = (handle: RadioHandle) => {
    const panel = new RadioPanel(scanner, handle);
    panels.set(handle.id, panel);
    panelsBox.insertBefore(panel.element, packets.element);
  };

  scanner.onChange(() => {
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(render);
    }
  });
  scanner.onSpectrum((radioId, e) => panels.get(radioId)?.onSpectrum(e.startHz, e.binHz, e.db, e.floorDb, e.thresholdDb));
  setInterval(() => {
    for (const panel of panels.values()) panel.tick();
  }, WATERFALL_INTERVAL_MS);

  render();
  if (scanner.hasUsb) {
    navigator.usb.addEventListener('disconnect', (e) => {
      const name = scanner.radioUnplugged(e.device);
      if (name) showMessage(`${name} was unplugged. It will come back when you plug it in again.`);
    });
    navigator.usb.addEventListener('connect', () => {
      showMessage('');
      void scanner.addPermittedRadios();
    });
    await scanner.addPermittedRadios();
  }
}

boot().catch((error: Error) => {
  document.body.textContent = `The scanner could not start: ${error.message}`;
});
