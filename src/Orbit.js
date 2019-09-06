'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter

const OrbitDB = require('orbit-db')
const Identities = require('orbit-db-identity-provider')
const Logger = require('logplease')

const Channel = require('./Channel')

const logger = Logger.create('Orbit', { color: Logger.Colors.Green })

Logger.setLogLevel(
  process.env.NODE_ENV === 'development' ? Logger.LogLevels.DEBUG : Logger.LogLevels.ERROR
)

const getAppPath = () =>
  process.type && process.env.ENV !== 'dev' ? process.resourcesPath + '/app/' : process.cwd()

const defaultOptions = {
  dbOptions: {
    directory: path.join(getAppPath(), '/orbit/orbitdb') // path to orbit-db file
  },
  channelOptions: {}
}

class Orbit {
  constructor (ipfs, options = {}) {
    this.events = new EventEmitter()
    this._ipfs = ipfs
    this._orbitdb = null
    this._user = null
    this._channels = {}
    this._peers = []
    this._pollPeersTimer = null
    this._options = Object.assign({}, defaultOptions, options)
    this._joiningQueue = {}
    this._connecting = false
  }

  /* Public properties */

  get user () {
    return this._user
  }

  get channels () {
    return this._channels
  }

  get peers () {
    return this._peers
  }

  get online () {
    return !!this._orbitdb
  }

  /* Public methods */

  async connect (credentials = {}) {
    if (this._orbitdb) throw new Error('Already connected')
    if (this._connecting) throw new Error('Already connecting')
    else this._connecting = true

    logger.info(`Connecting to Orbit as ${JSON.stringify(credentials)}`)

    if (typeof credentials === 'string') {
      credentials = { username: credentials }
    }

    if (!credentials.username) throw new Error("'username' not specified")

    this._user = {
      identity: await Identities.createIdentity({
        id: credentials.username
      }),
      profile: {
        name: credentials.username,
        location: 'Earth',
        image: null
      }
    }

    this._orbitdb = await OrbitDB.createInstance(
      this._ipfs,
      Object.assign(this._options.dbOptions, {
        directory: this._options.directory,
        identity: this.user.identity
      })
    )

    this._startPollingForPeers()

    logger.info(`Connected to Orbit as "${this.user.profile.name}"`)

    this.events.emit('connected', this.user)
  }

  async disconnect () {
    if (!this._orbitdb) return

    logger.warn('Disconnected')

    await this._orbitdb.disconnect()
    this._connecting = false
    this._orbitdb = null
    this._user = null
    this._channels = {}

    if (this._pollPeersTimer) clearInterval(this._pollPeersTimer)

    this.events.emit('disconnected')
  }

  join (channelName) {
    if (!channelName || channelName === '') {
      return Promise.reject(new Error('Channel not specified'))
    } else if (this._channels[channelName]) {
      return Promise.resolve(this._channels[channelName])
    } else if (!this._joiningQueue[channelName]) {
      this._joiningQueue[channelName] = new Promise(resolve => {
        logger.debug(`Join #${channelName}`)

        const options = Object.assign(
          {
            accessController: {
              write: ['*'] // Allow anyone to write to the channel
            }
          },
          this._options.channelOptions
        )

        this._orbitdb.log(channelName, options).then(feed => {
          this._channels[channelName] = new Channel(this, channelName, feed)
          logger.debug(`Joined #${channelName}, ${feed.address.toString()}`)
          this.events.emit('joined', channelName, this._channels[channelName])
          delete this._joiningQueue[channelName]
          resolve(this._channels[channelName])
        })
      })
    }

    return this._joiningQueue[channelName]
  }

  async leave (channelName) {
    const channel = this.channels[channelName]

    if (channel) {
      await channel.feed.close()
      delete this._channels[channelName]
      logger.debug('Left channel #' + channelName)
    }

    this.events.emit('left', channelName)
  }

  async send (channelName, message, replyToHash) {
    if (!channelName || channelName === '') throw new Error('Channel must be specified')
    if (!message || message === '') throw new Error("Can't send an empty message")
    if (!this.user) throw new Error("Something went wrong: 'user' is undefined")

    logger.debug(`Send message to #${channelName}: ${message}`)

    const data = {
      content: message.substring(0, 2048),
      meta: { from: this.user.profile, type: 'text', ts: new Date().getTime() }
    }

    return this._postMessage(channelName, data)
  }

  /*
    addFile(channel, source) where source is:
    {
      // for all files, filename must be specified
      filename: <filepath>,    // add an individual file
      // and optionally use one of these in addition
      directory: <path>,       // add a directory
      buffer: <Buffer>,        // add a file from buffer
      // optional meta data
      meta: <meta data object>
    }
  */
  async addFile (channelName, source) {
    if (!source || (!source.filename && !source.directory)) {
      throw new Error('Filename or directory not specified')
    }

    async function _addToIpfsJs (data) {
      const result = await this._ipfs.add(Buffer.from(data))
      const isDirectory = false
      const hash = result[0].hash
      return { hash, isDirectory }
    }

    async function _addToIpfsGo (filename, filePath) {
      const result = await this._ipfs.add({ path: filePath })
      // last added hash is the filename --> we added a directory
      // first added hash is the filename --> we added a file
      const isDirectory = result[0].path.split('/').pop() !== filename
      const hash = isDirectory ? result[result.length - 1].hash : result[0].hash
      return { hash, isDirectory }
    }

    logger.info(`Adding file from path '${source.filename}'`)

    const isBuffer = source.buffer && source.filename
    const name = source.directory
      ? source.directory.split('/').pop()
      : source.filename.split('/').pop()
    const size = source.meta && source.meta.size ? source.meta.size : 0

    let addToIpfs

    if (isBuffer) {
      // Adding from browsers
      addToIpfs = _addToIpfsJs.bind(this, source.buffer)
    } else if (source.directory) {
      // Adding from Electron
      addToIpfs = _addToIpfsGo.bind(this, name, source.directory)
    } else {
      addToIpfs = _addToIpfsGo.bind(this, name, source.filename)
    }

    const upload = await addToIpfs()

    logger.info(`Added file '${source.filename}' as`, upload)

    // Create a post
    const data = {
      content: upload.hash,
      meta: Object.assign(
        {
          from: this.user.profile,
          type: upload.isDirectory ? 'directory' : 'file',
          ts: new Date().getTime()
        },
        { size, name },
        source.meta || {}
      )
    }

    return this._postMessage(channelName, data)
  }

  getFile (hash) {
    return this._ipfs.catReadableStream(hash)
  }

  getDirectory (hash) {
    return this._ipfs.ls(hash).then(res => res.Objects[0].Links)
  }

  /* Private methods */

  _postMessage (channelName, data) {
    const feed = this._getChannelFeed(channelName)
    return feed.add(data)
  }

  _getChannelFeed (channelName) {
    if (!channelName || channelName === '') throw new Error('Channel not specified')
    const feed = this.channels[channelName].feed || null
    if (!feed) throw new Error(`Have not joined #${channelName}`)
    return feed
  }

  _startPollingForPeers () {
    async function update () {
      try {
        this._peers = (await this._updateSwarmPeers()) || []
        // TODO: get unique (new) peers and emit 'peer' for each instead of all at once
        this.events.emit('peers', this._peers)
      } catch (e) {
        logger.error(e)
      }
    }

    if (!this._pollPeersTimer) this._pollPeersTimer = setInterval(update.bind(this), 3000)
  }

  async _updateSwarmPeers () {
    try {
      const peers = await this._ipfs.swarm.peers()
      return Object.keys(peers)
        .filter(e => peers[e].addr !== undefined)
        .map(e => peers[e].addr.toString())
    } catch (e) {
      logger.error(e)
    }
  }
}

module.exports = Orbit
