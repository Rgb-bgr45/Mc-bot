const http = require('http')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const Vec3 = require('vec3')

// ---- Ayarlar (Render > Environment kısmından değiştirebilirsin) ----
const HOST = process.env.MC_HOST || 'sunucu-adresin.enzonic.xyz'
const PORT = parseInt(process.env.MC_PORT || '25565')
const VERSION = process.env.MC_VERSION || false // örn "1.21.4", boşsa otomatik
const USERNAME = process.env.MC_USERNAME || 'OduncuBot'
const LOGS_NEEDED = 56 // ev için gereken odun (4x4 ev, 3 blok yüksek, çatı dahil ~50)

// ---- Render'ı uyanık tutmak için küçük web sunucusu ----
http
  .createServer((req, res) => {
    res.writeHead(200)
    res.end('bot calisiyor')
  })
  .listen(process.env.PORT || 3000)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let houseBuilt = false
let home = null

function log(...a) {
  console.log(new Date().toISOString(), ...a)
}

function countLogs(bot) {
  return bot.inventory
    .items()
    .filter((i) => i.name.endsWith('_log'))
    .reduce((s, i) => s + i.count, 0)
}

async function gotoTimed(bot, goal, ms = 30000) {
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      bot.pathfinder.stop()
      rej(new Error('goto zaman asimi'))
    }, ms)
  })
  try {
    await Promise.race([bot.pathfinder.goto(goal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function wander(bot, radius = 10) {
  const base = home || bot.entity.position
  const x = base.x + (Math.random() * 2 - 1) * radius
  const z = base.z + (Math.random() * 2 - 1) * radius
  await gotoTimed(bot, new goals.GoalNear(x, base.y, z, 1), 20000)
}

async function gatherWood(bot, moves) {
  bot.pathfinder.setMovements(moves.dig)
  const ids = bot.registry.blocksArray.filter((b) => b.name.endsWith('_log')).map((b) => b.id)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 6 })
  if (positions.length === 0) {
    log('yakinda agac yok, geziyorum')
    await wander(bot, 30)
    return
  }
  const blocks = positions.map((p) => bot.blockAt(p)).filter(Boolean)
  let timer
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      bot.collectBlock.cancelTask()
      rej(new Error('toplama zaman asimi'))
    }, 60000)
  })
  try {
    await Promise.race([bot.collectBlock.collect(blocks), timeout])
  } finally {
    clearTimeout(timer)
  }
  log('odun:', countLogs(bot))
}

async function placeAt(bot, pos) {
  const target = bot.blockAt(pos)
  if (!target || target.name !== 'air') return

  const item = bot.inventory.items().find((i) => i.name.endsWith('_log'))
  if (!item) throw new Error('odun bitti')

  await gotoTimed(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), 20000)

  // Tam koyacagim yerin icindeysem uzaklas
  const p = bot.entity.position.floored()
  if (p.x === pos.x && p.z === pos.z && Math.abs(p.y - pos.y) < 2) {
    await gotoTimed(bot, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)), 10000)
  }

  await bot.equip(item, 'hand')

  const dirs = [
    [0, -1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [0, 1, 0],
  ]
  for (const [dx, dy, dz] of dirs) {
    const ref = bot.blockAt(pos.plus(new Vec3(dx, dy, dz)))
    if (ref && ref.boundingBox === 'block') {
      await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz))
      return
    }
  }
  throw new Error('dayanak blok yok: ' + pos)
}

async function buildHouse(bot, moves) {
  bot.pathfinder.setMovements(moves.noDig)
  const o = bot.entity.position.floored().offset(3, 0, 0)
  log('ev yapiliyor, baslangic:', o.toString())

  const list = []
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) {
      for (let z = 0; z < 4; z++) {
        const edge = x === 0 || x === 3 || z === 0 || z === 3
        if (!edge) continue
        if (x === 1 && z === 0 && y < 2) continue // kapi bosluğu
        list.push(o.offset(x, y, z))
      }
    }
  }
  for (let x = 0; x < 4; x++) {
    for (let z = 0; z < 4; z++) list.push(o.offset(x, 3, z)) // cati
  }

  for (const pos of list) {
    try {
      await placeAt(bot, pos)
    } catch (e) {
      log('blok konamadi:', e.message)
      if (e.message === 'odun bitti') return
    }
  }
  houseBuilt = true
  home = o.offset(2, 0, -2)
  log('ev bitti')
}

async function mainLoop(bot, moves) {
  while (bot._alive) {
    try {
      if (!houseBuilt && countLogs(bot) < LOGS_NEEDED) {
        await gatherWood(bot, moves)
      } else if (!houseBuilt) {
        await buildHouse(bot, moves)
      } else {
        bot.pathfinder.setMovements(moves.noDig)
        await wander(bot, 10)
        bot.setControlState('jump', true)
        await sleep(300)
        bot.setControlState('jump', false)
        await sleep(5000 + Math.random() * 10000)
      }
    } catch (e) {
      log('hata:', e.message)
      await sleep(3000)
    }
  }
}

function start() {
  log('baglaniyor...', HOST, PORT)
  const bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline',
  })
  bot._alive = true
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlock)

  bot.once('spawn', () => {
    log('sunucuya girdi')
    const dig = new Movements(bot)
    const noDig = new Movements(bot)
    noDig.canDig = false
    noDig.allow1by1towers = false
    mainLoop(bot, { dig, noDig })
  })

  bot.on('death', () => log('oldu, tekrar dogacak'))
  bot.on('kicked', (r) => log('atildi:', r))
  bot.on('error', (e) => log('baglanti hatasi:', e.message))
  bot.once('end', () => {
    bot._alive = false
    log('baglanti koptu, 10 sn sonra tekrar')
    setTimeout(start, 10000)
  })
}

start()
