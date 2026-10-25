// priority: 30
// Samsara — graves and their keys (Corail Tombstone). ONLY HUMANS HAVE GRAVES.
//
// Decided 2026-10-22 (the user): Tombstone stays for its grave and key and nothing else
// (its config switches the rest off). A human's death leaves the grave and the key, as
// Tombstone makes them. Any other birth's death leaves NO grave -- its items drop on the
// ground as vanilla drops them -- and in any other birth the player does not hold a grave
// key: Samsara keeps it (nbt.graveKeys) and gives it back at the next human life. So the
// only grave and key that ever exist are a human's, however many births ago that was. A
// preta, born at that grave (samsara_rebirth.js), gets its key back only if it is reborn
// human (its life ends in old age, like every other -- config.aging).
//
// PRIORITY 30: no load-order dependency. Everything here reads birthRealm when it RUNS
// (a respawn's key sync is queued for the next tick), and global.SMS.refuse comes from
// samsara_realms.js (60), which loads first anyway.
//
// From the installed jars (tombstone-neoforge-1.21.1-9.5.6, neoforge-21.1.264):
//   - Tombstone builds the grave in LivingDropsEvent at priority LOW with
//     receiveCanceled, and returns (logging a warning) when the event is already
//     cancelled -- so a HIGH listener that cancels it means no grave.
//   - Keys a player carries at death go into Tombstone's tb_key_stacks and come back at
//     PlayerRespawnEvent, LOWEST priority -- AFTER KubeJS's respawned (NORMAL), where
//     samsara_rebirth.js applies the new birth. Hence the sync again a tick later.
//   - The owner opens their own grave with no key at all (BlockGrave.activatePlayerGrave,
//     right-click), or by SNEAKING inside it (entityInside, per the client option
//     activate_grave_by_sneaking -- off in config/tombstone-client.toml; no event to
//     refuse it with). The key teleports to the grave, across dimensions.
//   - ItemStack.save(HolderLookup.Provider) / ItemStack.parseOptional(Provider,
//     CompoundTag) round-trip a stack; Entity.registryAccess() is the provider.
//   - A key is ENCHANTED (hold right-click: carried to the grave) when its tb_enchanted
//     data component is true: ItemGraveKey.isEnchanted reads ModDataComponents.ENCHANTED
//     (a Boolean, default false), and setEnchant writes it. KubeJS's
//     ComponentFunctions.override(DataComponentType, Object) sets a component directly.
//
// Nothing here runs without the mod (Platform.isLoaded).

function tombstoneLoaded() {
    try {
        return Platform.isLoaded(global.SMS.config.graves.mod) === true
    } catch (ignored) {
        return false
    }
}

// A human life: the only one that keeps graves and keys. A liberated player is outside
// the cycle and under no realm's rules, so it counts too.
function humanLife(player) {
    try {
        if (global.SMS.isLiberated(player)) return true
    } catch (ignored) {
        // fall through to the birth realm
    }
    return global.SMS.birthRealmOf(player) === 'human'
}

function isKey(stack) {
    try {
        return !!stack && '' + stack.id === global.SMS.config.graves.keyItem
    } catch (ignored) {
        return false
    }
}

// net.minecraft.world.item.ItemStack, loaded once, on first use.
var ItemStackClass = null
function itemStacks() {
    if (ItemStackClass === null) ItemStackClass = Java.loadClass('net.minecraft.world.item.ItemStack')
    return ItemStackClass
}

// ---- The keep: grave keys Samsara holds outside a human life -----------------------
//
// A compound under nbt.graveKeys: `n` (how many) and k0..k<n-1>, each a stack saved with
// ItemStack.save. Inside PlayerPersisted, so it follows the player through every clone.

function keepOf(player) {
    const tag = global.SMS.persistedTag(player)
    const key = global.SMS.config.nbt.graveKeys
    const keep = tag.getCompound(key)
    tag.put(key, keep)
    return keep
}

function keptCount(keep) {
    var n = Number(keep.getDouble('n'))
    return isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function keepStack(player, stack) {
    const keep = keepOf(player)
    const n = keptCount(keep)
    keep.put('k' + n, stack.save(player.registryAccess()))
    keep.putDouble('n', n + 1)
}

// Every grave key in the player's inventory (main, armour and offhand slots) into the
// keep. Returns how many.
function keepFromInventory(player) {
    const inv = player.getInventory()
    const size = inv.getContainerSize()
    var moved = 0
    for (var i = 0; i < size; i++) {
        var stack = inv.getItem(i)
        if (!isKey(stack)) continue
        keepStack(player, stack)
        inv.removeItemNoUpdate(i)
        moved++
    }
    return moved
}

// Tombstone's ENCHANTED component type, loaded once (null when it cannot be: the keys
// then come back plain, and the warning says so once).
var enchantedType = undefined
function enchantedComponent() {
    if (enchantedType !== undefined) return enchantedType
    enchantedType = null
    try {
        enchantedType = Java.loadClass('ovh.corail.tombstone.registry.ModDataComponents').ENCHANTED || null
    } catch (e) {
        console.warn(`[Samsara] could not load Tombstone's enchanted-key component; returned keys stay plain: ${e}`)
    }
    return enchantedType
}

// Make a returned key the enchanted kind (config.graves.enchantReturnedKeys, decided
// 2026-10-24, the user): every key Samsara hands back can carry its owner to the grave.
function enchantKey(stack) {
    if (global.SMS.config.graves.enchantReturnedKeys !== true) return false
    const type = enchantedComponent()
    if (!type) return false
    try {
        stack.override(type, true)
        return true
    } catch (e) {
        console.warn(`[Samsara] could not enchant a returned grave key: ${e}`)
        return false
    }
}

// Every kept key back into the inventory -- or at the player's feet, if it is full --
// enchanted (enchantKey). Returns how many.
function giveBack(player) {
    const keep = keepOf(player)
    const n = keptCount(keep)
    if (n === 0) return 0
    const access = player.registryAccess()
    var given = 0
    for (var i = 0; i < n; i++) {
        var saved = keep.getCompound('k' + i)
        keep.remove('k' + i)
        var stack = itemStacks().parseOptional(access, saved)
        if (!stack || stack.isEmpty()) continue
        enchantKey(stack)
        if (!player.getInventory().add(stack)) player.drop(stack, false)
        given++
    }
    keep.putDouble('n', 0)
    return given
}

global.SMS.graves = {
    // How many keys Samsara is keeping for this player.
    keysKept: player => keptCount(keepOf(player)),

    // Make the player's keys follow their birth: in a human life, give back what was
    // kept; in any other, keep what they carry. Called from applyRealmEffects (every
    // birth, login, /karma realm, liberation, a preta's end) and a tick after every
    // respawn. Returns a note for the realm-effects log line ('' when nothing moved).
    syncKeys: player => {
        if (!tombstoneLoaded() || !player) return ''
        if (humanLife(player)) {
            var given = giveBack(player)
            return given > 0 ? 'returned ' + given : ''
        }
        var moved = keepFromInventory(player)
        return moved > 0 ? 'kept ' + moved : ''
    },

    // LivingDropsEvent, at HIGH: a death outside a human life leaves no grave. Its keys
    // go into the keep (it never held its human key, but it may have picked one up), the
    // rest drop on the ground exactly as vanilla would have dropped them -- the captured
    // ItemEntities are already placed and moving -- and the event is cancelled, which is
    // what stops Tombstone (LOW, receiveCanceled) from making a grave. Returns whether it
    // acted.
    // EVERYTHING that can throw runs BEFORE the cancel: once the event is cancelled, the
    // items exist nowhere but in `items`, so a throw after it deletes them. That happened
    // in game on 2026-10-24 -- vanilla's level() (shadowed by KubeJS's `level` bean, N9)
    // threw right after the cancel, and 16 non-human deaths lost everything they carried.
    onDrops: event => {
        const player = event.getEntity()
        if (!player || !player.isPlayer()) return false
        if (!tombstoneLoaded() || humanLife(player)) return false
        const level = player.getLevel()
        const items = []
        const it = event.getDrops().iterator()
        while (it.hasNext()) items.push(it.next())
        event.setCanceled(true)
        var kept = 0
        var dropped = 0
        for (var i = 0; i < items.length; i++) {
            try {
                var stack = items[i].getItem()
                if (isKey(stack)) {
                    keepStack(player, stack)
                    kept++
                } else {
                    level.addFreshEntity(items[i])
                    dropped++
                }
            } catch (e) {
                console.warn(`[Samsara] ${player.profile.name}: a death drop was lost: ${e}`)
            }
        }
        console.info(
            `[Samsara] ${player.profile.name} died born-${global.SMS.birthRealmOf(player)}: no grave` +
                ` (only humans have graves); ${dropped} stack(s) dropped` + (kept > 0 ? `, ${kept} key(s) kept` : '')
        )
        return true
    },
}

// The drops veto: a native listener, so it can sit at HIGH, above Tombstone's LOW. In a
// try: a top-level throw here would abort the rest of this file.
try {
    NativeEvents.onEvent(
        Java.loadClass('net.neoforged.bus.api.EventPriority').HIGH,
        Java.loadClass('net.neoforged.neoforge.event.entity.living.LivingDropsEvent'),
        event => {
            try {
                global.SMS.graves.onDrops(event)
            } catch (e) {
                console.warn(`[Samsara] grave veto failed (a non-human death may leave a grave, or lose its items): ${e}`)
            }
        }
    )
} catch (e) {
    console.error(`[Samsara] could not register the grave veto -- every death leaves a grave: ${e}`)
}

// ---- Keys come back after a respawn: sync again on the next tick ----------------
//
// Tombstone restores the keys a human carried at PlayerRespawnEvent LOWEST, after
// samsara_rebirth.js applied the new birth (and synced then, too early to see them).
// Queue-and-drain against the tick clock (project rule 10).
global.SMS.keySync = global.SMS.keySync || {}

PlayerEvents.respawned(event => {
    try {
        if (!tombstoneLoaded()) return
        global.SMS.keySync['' + event.entity.uuid] = (global.SMS.tickClock || 0) + 1
    } catch (ignored) {
        // nothing to queue; the next login syncs anyway
    }
})

ServerEvents.tick(event => {
    const due = global.SMS.keySync
    const ids = Object.keys(due)
    if (ids.length === 0) return
    const now = global.SMS.tickClock || 0
    var players = null
    try {
        players = event.server.players
    } catch (ignored) {
        return
    }
    for (var i = 0; i < ids.length; i++) {
        if (now < due[ids[i]]) continue
        delete due[ids[i]]
        for (var j = 0; j < players.size(); j++) {
            var p = players.get(j)
            if ('' + p.uuid !== ids[i]) continue
            try {
                var note = global.SMS.graves.syncKeys(p)
                if (note) console.info(`[Samsara] grave keys: ${p.profile.name} born-${global.SMS.birthRealmOf(p)}: ${note}`)
            } catch (e) {
                console.warn(`[Samsara] grave key sync failed for ${p.profile.name}: ${e}`)
            }
        }
    }
})

// ---- Refusals: only a human opens a grave or uses its key --------------------------
//
// Right-click is the owner's way into their grave without a key, so it is refused
// outside a human life (the sneak-in path is off in Tombstone's client config). A key
// is normally in the keep outside a human life; this refuses one picked up all the same.
// Each sends its message FIRST and cancels LAST, outside any try (project rule 7).
BlockEvents.rightClicked(event => {
    if (!tombstoneLoaded()) return
    const player = event.getEntity()
    if (!player) return
    var id = ''
    try {
        id = '' + event.getBlock().id
    } catch (ignored) {
        id = ''
    }
    if (global.SMS.config.graves.graveBlocks.indexOf(id) === -1) return
    if (humanLife(player)) return
    if (global.SMS.refuse) global.SMS.refuse(player, 'Only a human can open a grave.')
    event.cancel()
})

ItemEvents.rightClicked(event => {
    if (!tombstoneLoaded()) return
    const player = event.getEntity()
    if (!player || !isKey(event.getItem())) return
    if (humanLife(player)) return
    if (global.SMS.refuse) global.SMS.refuse(player, 'Only a human can use a grave\'s key.')
    event.cancel()
})

// ---- Nothing else of Tombstone --------------------------------------------------
//
// The user wants only the grave and its key. Its config turns off what it can (the
// respawn Ghostly Shape, enchantments, potions, magic items, alignment, sieges, the Grave
// Guardian, events, injected loot); what it cannot, its recipes, go here. The grave key
// is never crafted -- Tombstone makes it at a death -- so it is untouched.
ServerEvents.recipes(event => {
    if (!tombstoneLoaded()) return
    event.remove({ mod: global.SMS.config.graves.mod })
})

console.info('[Samsara] graves registered (only humans have graves)')
