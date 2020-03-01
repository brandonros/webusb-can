let device = null
const sendQueue = []

const moduleArbitrationIds = {
  'w213-cpc': {
    source: 0x7E5,
    destination: 0x7ED
  },
  'w213-tcu': {
    source: 0x749,
    destination: 0x729
  },
  'w213-suspension': {
    source: 0x744,
    destination: 0x724
  },
  'w213-ecu': {
    source: 0x7E0,
    destination: 0x7E8
  }
}

const messages = {
  startDiagnosticSession02: [0x02, 0x10, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00],
  startDiagnosticSession03: [0x02, 0x10, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00],
  diagnosticSession03Started: [0x06, 0x50, 0x03, 0x00, 0x14, 0x00, 0xC8, 0xAA],
  requestSeed05: [0x02, 0x27, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00],
  requestSeed11: [0x02, 0x27, 0x1, 0x00, 0x00, 0x00, 0x00, 0x00],
  readSoftwareNumber: [0x03, 0x22, 0xF1, 0x21, 0x00, 0x00, 0x00, 0x00],
  readPartNumber: [0x03, 0x22, 0xF1, 0x11, 0x00, 0x00, 0x00, 0x00],
  readVin: [0x03, 0x22, 0xF1, 0x90, 0x00, 0x00, 0x00, 0x00],
  continuationFrame: [0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  testerPresent: [0x02, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
}

const buf2hex = (buf) => Array.prototype.map.call(new Uint8Array(buf), x => ('00' + x.toString(16)).slice(-2)).join('')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const send = async (device, frame) => {
  const endpoint = device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'out')
  const endpointNumber = endpoint.endpointNumber
  const frameLength = 0x14
  const result = await device.transferOut(endpointNumber, frame)
  if (result.status !== 'ok' || result.bytesWritten !== frameLength) {
    throw new Error('Write error')
  }
  return result
}

const drainSendQueue = async (device) => {
  while (sendQueue.length) {
    const frame = sendQueue.shift()
    await send(device, frame)
    log(`> ${buf2hex(frame)}`)
  }
}

const readWriteLoop = async (device, cb) => {
  await drainSendQueue(device)
  const endpoint = device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'in')
  const endpointNumber = endpoint.endpointNumber
  const maxFrameLength = 32
  const result = await device.transferIn(endpointNumber, maxFrameLength)
  if (result.status !== 'ok') {
    throw new Error('Read error')
  }
  cb(result)
  readWriteLoop(device, cb)
}

const initDevice = async () => {
  const device = await navigator.usb.requestDevice({
    filters: [
      {
        vendorId: 0x067B,
        productId: 0x2303
      }
    ]
  })
  await device.open()
  const [ configuration ] = device.configurations
  if (device.configuration === null) {
    await device.selectConfiguration(configuration.configurationValue)
  }
  await device.claimInterface(configuration.interfaces[0].interfaceNumber)
  await device.selectAlternateInterface(configuration.interfaces[0].interfaceNumber, 0)
  return device
}

const log = (frame) => {
  const last1000Lines = document.querySelector('#logs').value.split('\n').slice(0, 1000).join('\n')
  document.querySelector('#logs').value = `${frame}\n${last1000Lines}`
}

const initReadWriteLoop = async () => {
  readWriteLoop(device, (result) => {
    log(`< ${buf2hex(result.data.buffer)}`)
  })
}

const initEvents = () => {
  const $module = document.querySelector('#module')
  const $message = document.querySelector('#message')

  document.querySelector('#open').addEventListener('click', async () => {
    try {
      device = await initDevice()
      initReadWriteLoop()
      document.querySelector('#status').innerHTML = `status: connected (${device.productName})`
    } catch (err) {
      alert(err)
    }
  })

  document.querySelector('#close').addEventListener('click', async () => {
    try {
      await device.close()
      device = null
      document.querySelector('#status').innerHTML = 'status: not connected'
    } catch (err) {
      alert(err)
    }
  })

  document.querySelector('#send').addEventListener('click', async () => {
    const { source: sourceArbitrationId } = moduleArbitrationIds[$module.value]
    const message = messages[$message.value]
    sendQueue.push(buildFrame(sourceArbitrationId, message))
  })
}

initEvents()
