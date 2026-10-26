// group.call desktop: the web app in its own window, with the groupcall CLI
// bundled inside (resources/cli). tel: links go to the system's phone app
// (FaceTime, Phone Link, a softphone), everything off-site to the browser.
const { app, BrowserWindow, shell, Menu } = require('electron')

const SITE = process.env.GROUPCALL_URL || 'https://group.call.pit.world'
const ORIGIN = new URL(SITE).origin

function open() {
  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 380,
    backgroundColor: '#07090c',
    title: 'group.call',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  const outside = (url) => {
    if (url.startsWith('tel:') || !url.startsWith(ORIGIN)) {
      // Sign in with CoinPay stays in the window: it comes straight back here.
      if (url.startsWith('https://coinpayportal.com/') && url.includes('/oauth/')) return false
      shell.openExternal(url)
      return true
    }
    return false
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!outside(url)) win.loadURL(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (outside(url)) event.preventDefault()
  })
  win.loadURL(`${SITE}/rooms`)
}

Menu.setApplicationMenu(null)
app.whenReady().then(() => {
  open()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && open())
})
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
