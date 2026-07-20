(() => {
  const SOURCE = 'poi-sortie-odds-engine'
  let running = false

  const send = (message) => {
    window.parent.postMessage({ source: SOURCE, ...message }, '*')
  }

  // 与胜率模拟同源的能力判定：直接用 SIM 构建舰队并调用舰船对象的方法
  const inspectShips = (ships) => (ships || []).map((ship) => ({
    oasw: !!(ship.canOASW && ship.canOASW()),
    aaciTypes: Array.isArray(ship.AACItype) ? ship.AACItype.slice() : [],
    dayCutin: !!(ship.canAS && ship.canAS()),
    specialAttack: typeof window.canSpecialAttackUnique === 'function'
      ? !!window.canSpecialAttackUnique(ship, false, true)
      : false,
  }))

  const handleInspect = (message) => {
    const fleetInput = message.input && message.input.fleetF
    if (!fleetInput) {
      send({ type: 'error', id: message.id, error: '缺少舰队输入' })
      return
    }
    const fleet = window.SIM.createSimFleet(fleetInput, 0, false)
    const main = inspectShips(fleet.ships)
    // 构建后的舰队对象里护卫队在 combinedWith（shipsC 是输入格式的字段名）
    const escort = inspectShips(fleet.combinedWith && fleet.combinedWith.ships)
    const specialFormations = []
    if (
      main.some((ship) => ship.specialAttack)
      && typeof window.canSpecialAttackUnique === 'function'
    ) {
      const formations = message.input.formations || [1, 2, 3, 4, 5]
      for (const formation of formations) {
        try {
          const testFleet = window.SIM.createSimFleet(
            Object.assign({}, fleetInput, { formation }),
            0,
            false,
          )
          const triggered = (testFleet.ships || []).some(
            (ship) => window.canSpecialAttackUnique(ship, false, false),
          )
          if (triggered) specialFormations.push(formation)
        } catch (error) {
          // 单个阵形构建失败不影响其余判定
        }
      }
    }
    // 本队 TP 容量（运输图用；getTransport 已含舰种+装备 TP 表）
    let transportS = 0
    try {
      if (typeof fleet.getTransport === 'function') {
        transportS = fleet.getTransport()
        if (fleet.combinedWith && typeof fleet.combinedWith.getTransport === 'function') {
          transportS += fleet.combinedWith.getTransport()
        }
      }
    } catch (error) {
      transportS = 0
    }
    send({
      type: 'result',
      id: message.id,
      result: { main, escort, specialFormations, transportS },
    })
  }

  // 友军舰队手动预设用的舰船选择列表：只从 window.SHIPDATA 取轻量字段
  // （id/name/nameJP），不把整份舰船数据库搬进主视图 bundle
  const handleListShips = (message) => {
    const data = window.SHIPDATA || {}
    const ships = Object.keys(data)
      .map((key) => Number(key))
      .filter((id) => window.COMMON && window.COMMON.isShipIdPlayable(id))
      .map((id) => ({ id, name: data[id].name || '', nameJP: data[id].nameJP || '' }))
      .filter((ship) => ship.name)
    send({ type: 'result', id: message.id, result: { ships } })
  }

  window.addEventListener('message', (event) => {
    const message = event.data
    if (event.source !== window.parent || message?.source !== 'poi-sortie-odds-plugin') return
    if (!message.id) return
    if (message.type === 'listShips') {
      try {
        handleListShips(message)
      } catch (error) {
        send({ type: 'error', id: message.id, error: String(error?.stack || error) })
      }
      return
    }
    if (running) {
      send({ type: 'error', id: message.id, error: '模拟器正忙，请稍后重试' })
      return
    }
    if (message.type === 'inspect') {
      try {
        handleInspect(message)
      } catch (error) {
        send({ type: 'error', id: message.id, error: String(error?.stack || error) })
      }
      return
    }
    if (message.type !== 'run') return
    running = true
    try {
      window.SIM.resetStats()
      window.SIM.runStats(message.input, (payload) => {
        if (payload.errors?.length) {
          running = false
          send({
            type: 'error',
            id: message.id,
            error: payload.errors.map((error) => error.txt || error.key).join('；'),
          })
          return
        }
        if (payload.result) {
          running = false
          send({
            type: 'result',
            id: message.id,
            result: {
              result: payload.result,
              warnings: payload.warnings || [],
            },
          })
          return
        }
        const total = payload.progressTotal || 1
        send({ type: 'progress', id: message.id, progress: (payload.progress || 0) / total })
      })
    } catch (error) {
      running = false
      send({ type: 'error', id: message.id, error: String(error?.stack || error) })
    }
  })

  send({ type: 'ready' })
})()
