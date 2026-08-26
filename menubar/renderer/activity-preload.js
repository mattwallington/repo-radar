'use strict';
// Task 4.1: the Activity window's DEDICATED preload -- deliberately NOT the app's shared
// preload.js, so the Activity window inherits nothing but the four channels below.
//
// This is the renderer's entire bridge: four functions, one allowlisted invoke channel each,
// nothing else. `ipcRenderer` itself is never handed to the page (that would be a
// send-anything hatch), `require` is never handed to the page, and no channel name is ever
// built at runtime. The window runs with contextIsolation, nodeIntegration off and
// sandbox on, so the only module this file may load is electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('activityApi', {
  list: (filter) => ipcRenderer.invoke('activity:list', filter),
  get: (activityId) => ipcRenderer.invoke('activity:get', activityId),
  export: (filter) => ipcRenderer.invoke('activity:export', filter),
  reveal: (activityId) => ipcRenderer.invoke('activity:reveal', activityId),
});
