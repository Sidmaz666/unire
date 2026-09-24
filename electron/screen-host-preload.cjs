// Preload for the hidden screen host window: forwards phone input received over
// WebRTC data channels to the Electron main process and selects the audio capture mode.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('unireHost', {
  input: (viewerId, message) => {
    if (typeof viewerId === 'string' && typeof message === 'string') {
      ipcRenderer.send('unire:input', viewerId, message);
    }
  },
  // Chooses how the next system-audio capture behaves; resolves to the mode in effect.
  setLoopbackMode: (muted) => ipcRenderer.invoke('unire:loopback-mode', Boolean(muted))
});
