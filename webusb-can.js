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
  continuationFrame: [0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  testerPresent: [0x02, 0x3E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
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

const GS_CAN_MODE_PAD_PKTS_TO_MAX_PKT_SIZE = (1 << 7)

let device = null
const sendQueue = []

const buf2hex = (buf) => Array.prototype.map.call(new Uint8Array(buf), x => ('00' + x.toString(16)).slice(-2)).join('')

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const setDeviceMode = async (device, mode, flags) => {
  const bRequest = GS_USB_BREQ_MODE
  const wValue = 0
  const wIndex = device.configurations[0].interfaces[0].interfaceNumber
  const data = new ArrayBuffer(8)
  const dataView = new DataView(data)
  dataView.setUint32(0, mode, true)
  dataView.setUint32(4, flags, true)
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
  dataView.setUint32(0, 0x0000BEEF, true) // little-endian
  return device.controlTransferOut({
    requestType: 'vendor',
    recipient: 'interface',
    request: bRequest,
    value: wValue,
    index: wIndex
  }, data)
}

const buildFrame = (arbitrationId, message) => {
  const frameLength = 0x14
  const data = new ArrayBuffer(frameLength)
  const dataView = new DataView(data)
  dataView.setUint32(0x00, 0xffffffff, true) // echo_id
  dataView.setUint32(0x04, arbitrationId, true) // can_id
  dataView.setUint8(0x08, 0x08) // can_dlc
  dataView.setUint8(0x09, 0x00) // channel
  dataView.setUint8(0x0A, 0x00) // flags
  dataView.setUint8(0x0B, 0x00) // reserved
  dataView.setUint8(0x0C, message[0])
  dataView.setUint8(0x0D, message[1])
  dataView.setUint8(0x0E, message[2])
  dataView.setUint8(0x0F, message[3])
  dataView.setUint8(0x10, message[4])
  dataView.setUint8(0x11, message[5])
  dataView.setUint8(0x12, message[6])
  dataView.setUint8(0x13, message[7])
  return data
}

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
  await setDeviceMode(device, GS_CAN_MODE_RESET, 0x00000000)
  await sendHostConfig(device)
  await setDeviceMode(device, GS_CAN_MODE_START, GS_CAN_MODE_PAD_PKTS_TO_MAX_PKT_SIZE)
  return device
}

const log = (frame) => {
  const last1000Lines = document.querySelector('#logs').value.split('\n').slice(0, 1000).join('\n')
  document.querySelector('#logs').value = `${frame}\n${last1000Lines}`
}

const initReadWriteLoop = async () => {
  readWriteLoop(device, (result) => {
    log(buf2hex(result.data.buffer))
  })
}

const initEvents = () => {
  const $module = document.querySelector('#module')
  const $message = document.querySelector('#message')

  document.querySelector('#open').addEventListener('click', async () => {
    try {
      device = await initDevice()
      sendQueue.push(buildFrame(0x7E0, messages.testerPresent)) // TODO: remove me
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
    const frame = buildFrame(sourceArbitrationId, message)
    sendQueue.push(frame)
  })
}

initEvents()
