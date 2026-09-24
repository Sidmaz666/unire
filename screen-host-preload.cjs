// Preload for the hidden screen host window: forwards phone input received over
// WebRTC data channels to the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('unireHost', {
  input: (viewerId, message) => {
    if (typeof viewerId === 'string' && typeof message === 'string') {
      ipcRenderer.send('unire:input', viewerId, message);
    }
  }
});
