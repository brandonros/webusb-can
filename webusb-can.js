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
  startDiagnosticSession03: [0x02, 0x10, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00],
  readSoftwareNumber: [0x03, 0x22, 0xF1, 0x21, 0x00, 0x00, 0x00, 0x00],
  readPartNumber: [0x03, 0x22, 0xF1, 0x11, 0x00, 0x00, 0x00, 0x00],
  readVin: [0x03, 0x22, 0xF1, 0x90, 0x00, 0x00, 0x00, 0x00],
  continuationFrame: [0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
}

const GS_USB_BREQ_HOST_FORMAT = 0
const GS_USB_BREQ_BITTIMING = 1
const GS_USB_BREQ_MODE = 2
const GS_USB_BREQ_BERR = 3
const GS_USB_BREQ_BT_CONST = 4
const GS_USB_BREQ_DEVICE_CONFIG = 5
const GS_USB_BREQ_TIMESTAMP = 6
const GS_USB_BREQ_IDENTIFY = 7

const GS_CAN_MODE_RESET = 0
const GS_CAN_MODE_START = 1

const USB_DIR_OUT = 0
const USB_DIR_IN = 0x80
const USB_TYPE_VENDOR = (0x02 << 5)
const USB_RECIP_INTERFACE = 0x01

let device = null

const buf2hex = (buf) => Array.prototype.map.call(new Uint8Array(buf), x => ('00' + x.toString(16)).slice(-2)).join('')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const resetDevice = async (device) => {
  const bRequest = GS_USB_BREQ_MODE
  const wValue = 0
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const data = new ArrayBuffer(8)
  const dataView = new DataView(data)
  dataView.setUint32(0, 0x00000000, true) // mode
  dataView.setUint32(4, 0x00000000, true) // flags
  return device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, data)
}

const sendHostConfig = async (device) => {
  const bRequest = GS_USB_BREQ_HOST_FORMAT
  const wValue = 1
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const data = new ArrayBuffer(4)
  const dataView = new DataView(data)
  dataView.setUint32(0, 0x0000BEEF, false) // not little-endian
  return device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, data)
}

const readDeviceConfig = async (device) => {
  const bRequest = GS_USB_BREQ_DEVICE_CONFIG
  const wValue = 1
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const length = 0x0C
  return device.controlTransferIn({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, length)
}

const fetchBitTimingConstants = async (device) => {
  const bRequest = GS_USB_BREQ_BT_CONST
  const wValue = 0
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const length = 0x28
  return device.controlTransferIn({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, length)
}

const startDevice = async (device) => {
  const bRequest = GS_USB_BREQ_MODE
  const wValue = 0
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const data = new ArrayBuffer(8)
  const dataView = new DataView(data)
  dataView.setUint32(0, 0x00000001, true) // mode
  dataView.setUint32(4, 0x00000000, true) // flags
  return device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, data)
}

const readLoop = async (device, cb) => {
  const endpoint = device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'in')
  const endpointNumber = endpoint.endpointNumber
  const frameLength = 0x14
  const result = await device.transferIn(endpointNumber, frameLength)
  if (result.status !== 'ok' || !result.data || result.data.byteLength !== frameLength) {
    throw new Error('Read error')
  }
  cb(result)
  readLoop(device, cb)
}

const send = async (device, arbitrationId, message) => {
  const endpoint = device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'out')
  const endpointNumber = endpoint.endpointNumber
  const frameLength = 0x14
  const data = new ArrayBuffer(frameLength)
  const dataView = new DataView(data)
  dataView.setUint32(0x00, 0xffffffff, true)
  dataView.setUint16(0x04, arbitrationId, true)
  dataView.setUint16(0x06, 0x0000, true)
  dataView.setUint32(0x08, 0x00000008, true)
  dataView.setUint8(0x0C, message[0])
  dataView.setUint8(0x0D, message[1])
  dataView.setUint8(0x0E, message[2])
  dataView.setUint8(0x0F, message[3])
  dataView.setUint8(0x10, message[4])
  dataView.setUint8(0x11, message[5])
  dataView.setUint8(0x12, message[6])
  dataView.setUint8(0x13, message[7])
  console.log(`> ${buf2hex(data)}`)
  const result = await device.transferOut(endpointNumber, data)
  if (result.status !== 'ok' || result.bytesWritten !== frameLength) {
    throw new Error('Write errir')
  }
  return result
}

const initDevice = async () => {
  const device = await navigator.usb.requestDevice({
    filters: [
      {
        vendorId: 0x1d50,
        productId: 0x606f
      },
      {
        vendorId: 0x0483,
        productId: 0x1234
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
  await resetDevice(device)
  await sendHostConfig(device)
  const deviceConfig = await readDeviceConfig(device)
  const bitTimingConstants = await fetchBitTimingConstants(device)
  await startDevice(device)
  return device
}

const log = (frame) => {
  const last1000Lines = document.querySelector('#logs').value.split('\n').slice(0, 1000).join('\n')
  document.querySelector('#logs').value = `${frame}\n${last1000Lines}`
}

const initReadLoop = async () => {
  readLoop(device, async (result) => {
    if (buf2hex(result.data.buffer) === 'ffffffffe0070000080000000322f12100000000') {
      await send(device, 0x7E8, Buffer.from([0x10, 0x21, 0x62, 0xF1, 0x21, 0x31, 0x37, 0x37])
    }
    if (buf2hex(result.data.buffer).includes('ffffffffe807')) {
      alert('got it')
    }
    /*const arbitrationId = result.data.getUint16(4, true)
    const frame = buf2hex(result.data.buffer).slice(24)
    const stringifiedFrame = JSON.stringify({
      type: 'in',
      arbitration_id: arbitrationId.toString(16).padStart(3, '0'),
      frame,
      captured: new Date().toISOString()
    })
    log(stringifiedFrame)*/
    log(buf2hex(result.data.buffer))
  })
}

const initEvents = () => {
  const $module = document.querySelector('#module')
  const $message = document.querySelector('#message')

  document.querySelector('#send').addEventListener('click', async () => {
    const { source: sourceArbitrationId } = moduleArbitrationIds[$module.value]
    const frame = messages[$message.value]
    const result = await send(device, sourceArbitrationId, frame)
    const stringifiedFrame = JSON.stringify({
      type: 'out',
      arbitration_id: sourceArbitrationId.toString(16).padStart(3, '0'),
      frame: buf2hex(frame),
      sent: new Date().toISOString()
    })
    log(stringifiedFrame)
    // TODO: send continuation frame?
  })

  document.querySelector('#open').addEventListener('click', async () => {
    try {
      device = await initDevice()
      initReadLoop()
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
}

initEvents()
