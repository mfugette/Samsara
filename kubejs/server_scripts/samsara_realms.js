// Samsara — realm penalties.
//
// CRITICAL RULE: penalties follow the player's `birthRealm`, NEVER the dimension they
// are standing in. Players still need the Nether (blaze rods, netherite) and the End
// for ordinary progression, so a human walking through a portal is just VISITING and
// takes nothing. Only a player *born* into a realm lives under its rules.
// See design doc section 7.
//
// Effects are declared in config.realmEffects. Realms with no entry have no penalties
// yet -- preta, asura, deva and brahma all need mods that are not installed.

global.SMS = global.SMS || {}

// The realm a player was BORN into. Falls back to human: a player who has never died
// has no birthRealm recorded, and the human realm is the no-penalty default.
// NOTE: goes through global.SMS.nbtString, which coerces the JAVA String that
// CompoundTag.getString returns into a real JS string. Without that coercion
// `config.realmDimensions[realm]` does not match its JS keys and this returned
// 'human' for every realm -- see the comment on nbtString in samsara_karma.js.
global.SMS.birthRealmOf = player => {
    try {
        var realm = global.SMS.nbtString(global.SMS.persistedTag(player), global.SMS.config.nbt.birthRealm)
        if (realm && global.SMS.isRealm(realm)) return realm
    } catch (ignored) {
        // fall through
    }
    return 'human'
}

// Effects table for a realm, or an empty object.
//
// Coerces the key for the same reason: a Java String passed in from NBT would miss
// every entry in realmEffects, so naraka's maxHealth was never found and the player
// kept full health. THIS was the full-health bug.
global.SMS.effectsFor = realm => {
    if (!realm) return {}
    var key = '' + realm
    return global.SMS.config.realmEffects[key] || {}
}

// ---- Applying and clearing effects -----------------------------------------

// Max health is the only *persistent* attribute change so far, so it has to be
// actively reset when a player is reborn somewhere else -- otherwise a player who
// escapes hell keeps five hearts forever.
const VANILLA_MAX_HEALTH = 20.0

// Read the current max health.
//
// `player.maxHealth` and `player.health` are NOT readable: LivingEntityMixin carries
// no @RemapForJS for getMaxHealth / getHealth / setHealth (verified by dumping the
// mixin). Only kjs$setMaxHealth exists for writing. The original code gated on
// `if (player.maxHealth !== target)`, which threw and dropped the whole body into its
// catch -- so realm health penalties never applied at all.
//
// kjs$getAttributeBaseValue's signature takes a net.minecraft Attribute OBJECT
// (`(Lnet/.../Attribute;)D` in LivingEntityKJS), but Rhino DOES coerce the registry-id
// string into one -- confirmed in game on 2026-10-18, where this returned real values
// (before=20, before=14) rather than throwing.
//
// Returns null when unreadable, which callers must treat as "set it anyway" rather
// than "skip": the whole point is that a missing getter must not disable the penalty.
// How often the preta clamp runs. 4 ticks = 5x/second: frequent enough that a meal
// cannot visibly push the bar past the cap, cheap enough to ignore (it is a numeric
// compare per online player, and it early-returns on realms with no foodCap).
const PRETA_INTERVAL_TICKS = 4

// On global.SMS, not a file-local `let`, for the same reason global.SMS.tickClock is:
// `global` survives /reload, so the clamp's cadence is not reset every time the
// scripts reload. It also lets the offline harness drive the throttle deterministically
// instead of inheriting whatever phase an earlier test left it in.
global.SMS.pretaCounter = global.SMS.pretaCounter || 0

function readMaxHealth(player) {
    try {
        var v = Number(player.getAttributeBaseValue('minecraft:generic.max_health'))
        if (isFinite(v) && v > 0) return v
    } catch (ignored) {
        // attribute API unavailable for this entity
    }
    return null
}

// ---- Clearing the PREVIOUS life -------------------------------------------
//
// DESIGN RULE: nothing from a previous life may carry into the current one.
//
// Most realm penalties are checked LIVE against birthRealm, so they stop applying the
// instant birthRealm changes and need no teardown. But anything that is stored --
// an attribute, queued work, a cached decision -- survives the rebirth unless it is
// explicitly cleared, and that is a bug every time.
//
// This function is the single place that resets stored per-life state. Every new
// effect that writes something persistent MUST be undone here, not just skipped while
// the new realm is active.
//
// Registry of what is stored vs live, as of 2026-10-18:
//   maxHealth       STORED attribute        -> reset below (to the new realm's value)
//   pendingFoodPenalty  STORED queue        -> cleared below
//   noCrafting      live check              -> no teardown needed
//   noContainers    live check              -> no teardown needed
//   noBlockPlacing  live check              -> no teardown needed
//   foodMultiplier  live check (+ queue)    -> queue cleared below
global.SMS.clearPreviousLife = player => {
    var cleared = []

    // A preta who eats and dies before the next tick would otherwise have the food
    // penalty applied to their NEW body, in a realm that does not have the penalty.
    try {
        var key = '' + player.uuid
        if (global.SMS.pendingFoodPenalty && global.SMS.pendingFoodPenalty[key] !== undefined) {
            delete global.SMS.pendingFoodPenalty[key]
            cleared.push('pendingFoodPenalty')
        }
    } catch (ignored) {
        // uuid unreadable; nothing to clear
    }

    // The renewed hunger effect is STORED state on the player: it outlives the realm
    // that applied it, because a MobEffect persists until it lapses or is removed.
    // A preta reborn as a human would otherwise keep starving for up to
    // hungerEffect.durationTicks into their new life. Removed unconditionally rather
    // than only for ex-pretas: /effect clear on an effect you do not have is a no-op,
    // and this must also undo an effect applied before a config change.
    try {
        if (player.isPlayer()) {
            player.runCommandSilent('effect clear @s minecraft:hunger')
            cleared.push('hungerEffect')
        }
    } catch (ignored) {
        // runCommandSilent unavailable; the effect lapses on its own
    }

    // The anti-spam timer for refusal messages. Harmless, but a stale entry means the
    // first refusal in a new life can be silently swallowed.
    try {
        var id2 = '' + player.uuid
        if (global.SMS.lastNotified && global.SMS.lastNotified[id2] !== undefined) {
            delete global.SMS.lastNotified[id2]
            cleared.push('notifyCooldown')
        }
    } catch (ignored) {
        // nothing to clear
    }

    return cleared
}

global.SMS.applyRealmEffects = player => {
    const realm = global.SMS.birthRealmOf(player)

    // A liberated player is outside the cycle, so realm penalties no longer apply --
    // the project notes' liberation section lists realm penalties among the things turned
    // off. Passing an unmapped realm name makes the code below reset maxHealth to
    // vanilla 20 and leaves every live-checked restriction (crafting, containers,
    // placing) reading as absent, which is exactly the intended teardown. Routing
    // the liberation case through the SAME path rather than returning early is what
    // guarantees a player liberated while born-naraka does not keep five hearts.
    var liberated = false
    try {
        liberated = global.SMS.isLiberated(player)
    } catch (ignored) {
        liberated = false
    }

    const fx = liberated ? {} : global.SMS.effectsFor(realm)
    const target = fx.maxHealth === undefined ? VANILLA_MAX_HEALTH : fx.maxHealth

    // Tear down stored state from the life that just ended, BEFORE applying the new
    // realm's effects. Note maxHealth is handled by the set below rather than here:
    // it is always written to the NEW realm's value (defaulting to vanilla 20), so a
    // realm with no maxHealth entry actively resets it rather than inheriting.
    const cleared = global.SMS.clearPreviousLife(player)

    var current = readMaxHealth(player)

    // Set unconditionally when we cannot read the current value -- idempotent, and far
    // better than skipping the penalty because a getter is missing.
    var applied = false
    if (current === null || current !== target) {
        try {
            player.setMaxHealth(target)
            applied = true
        } catch (e) {
            console.warn(`[Samsara] setMaxHealth(${target}) failed: ${e}`)
        }
    }

    // Log loudly enough that the next in-game test can CONFIRM this landed, rather
    // than us inferring it from the health bar. Reads back the attribute afterwards.
    var after = readMaxHealth(player)
    console.info(
        `[Samsara] realm effects: ${player.profile.name} born-${realm}` +
            ` maxHealth target=${target} before=${current} after=${after}` +
            ` (setMaxHealth called: ${applied})` +
            (cleared.length > 0 ? ` [cleared from previous life: ${cleared.join(', ')}]` : '')
    )

    // Current health is deliberately NOT touched. There is no setHealth and no
    // getHealth anywhere in KubeJS (grepped every class in the jar), and every
    // workaround involves damaging the player, which could kill someone on 1 hp.
    // Vanilla clamps health to the maximum on its own, so a player who drops from
    // 20 max to 10 may briefly show a full bar until the next damage or regen tick.
    // If the bar ever looks wrong after a rebirth, it corrects on the first tick of
    // damage or regeneration.

    return realm
}

// Re-apply whenever the player's realm could have changed or the entity was rebuilt.
PlayerEvents.loggedIn(event => {
    global.SMS.applyRealmEffects(event.player)
})

// ORDERING. This used to claim it "runs after the rebirth handler has written the new
// birthRealm". It does not. KubeJS loads server_scripts ALPHABETICALLY, and
// samsara_realms.js sorts before samsara_rebirth.js, so this handler registered first
// and therefore ran first -- reading the PREVIOUS life's birthRealm.
//
// That is why forcing naraka and dying left the player on full health: at the moment
// this ran, birthRealm was still the old realm, so it applied that realm's effects
// (or reset to 20.0) and the rebirth handler then wrote 'naraka' with nothing left to
// re-read it.
//
// Rather than depend on file names, samsara_rebirth.js now calls applyRealmEffects
// itself right after it writes birthRealm. This handler stays as a safety net for
// respawns that the rebirth hook skips (notably an End return, where birthRealm is
// deliberately left alone and the existing realm's effects must persist).
PlayerEvents.respawned(event => {
    // Skip when the rebirth hook is going to handle this respawn itself.
    //
    // Both files hook this event and alphabetical load order puts THIS one first, so
    // it would otherwise run against the previous life's birthRealm -- visible in the
    // log as a stale pair:
    //     born-asura target=20 ...   <- this handler, old realm
    //     born-preta target=14 ...   <- rebirth hook, correct
    // The result was still right because the correct call landed second, but the first
    // call was wasted work and made the log actively misleading.
    //
    // samsara_rebirth.js sets pendingRebirth at death and clears it when it places the
    // player. If an entry is present, the rebirth hook has not run yet and WILL call
    // applyRealmEffects with the new realm -- so there is nothing useful to do here.
    try {
        var key = '' + event.entity.uuid
        if (global.SMS.pendingRebirth && global.SMS.pendingRebirth[key]) return
    } catch (ignored) {
        // cannot tell: fall through and apply, which is the safe direction
    }

    global.SMS.applyRealmEffects(event.entity)
})

// ---- Animal realm restrictions ---------------------------------------------

// An animal has no hands for tools and no mind for planning. It can still fight,
// forage, break blocks and carry items.

// Which restriction applies to THIS player right now, read fresh from birthRealm
// every time so it stops the instant they are reborn elsewhere.
//
// The old helper was `isAnimalBorn()`, which returned `noCrafting === true` and was
// then used to gate the CONTAINER and BLOCK-PLACING handlers as well. That coupled
// three independent restrictions to one flag:
//   - a realm with noBlockPlacing but no noCrafting would not have blocked placing;
//   - giving any realm noCrafting would silently switch on container and placement
//     restrictions it never asked for.
// Each handler now asks for the specific effect it enforces.
function hasEffect(player, name) {
    if (!player) return false
    try {
        if (!player.isPlayer()) return false
    } catch (ignored) {
        return false
    }

    // Liberation turns every realm penalty off. Checked here rather than in each
    // caller because all four live restrictions (crafting, containers, block
    // placing, and anything added later) funnel through this one function -- so a
    // liberated player born into the animal realm can craft and build again, which
    // is what "realm penalties are turned off for them" means in the project notes.
    try {
        if (global.SMS.isLiberated(player)) return false
    } catch (ignored) {
        // isLiberated unavailable (karma script not loaded): fall through and apply
        // the realm's effects normally rather than silently freeing everyone.
    }

    return global.SMS.effectsFor(global.SMS.birthRealmOf(player))[name] === true
}

// Tell the player why something was refused, but not on every tick of a held click.
const NOTIFY_COOLDOWN_TICKS = 40
// On global.SMS so global.SMS.clearPreviousLife() can reset a player's entry when
// they are reborn. Survives /reload, which is fine -- it is only a message throttle.
global.SMS.lastNotified = global.SMS.lastNotified || {}

function refuse(player, message) {
    try {
        var id = player.uuid ? '' + player.uuid : '' + player.profile.name
        var now = global.SMS.tickClock || 0
        var prev = global.SMS.lastNotified[id]
        if (prev === undefined || now - prev >= NOTIFY_COOLDOWN_TICKS || now < prev) {
            global.SMS.lastNotified[id] = now
            player.tell(Text.gray(message))
        }
    } catch (ignored) {
        // messaging is best-effort
    }
}

// Does this block id look like something an animal should not be able to open?
function isContainerBlock(id) {
    const suffixes = global.SMS.config.containerBlockSuffixes
    for (let i = 0; i < suffixes.length; i++) {
        if (id.endsWith(suffixes[i])) return true
    }
    return false
}

// Block crafting.
//
// Neither ItemEvents.crafted nor PlayerEvents.inventoryChanged is cancellable in
// KubeJS 6 (checked against the jar: no cancel/setCanceled member on either event),
// so crafting cannot be prevented outright. Two levers together get close:
//
//   1. Station access is refused above, which covers the crafting table, anvil,
//      smithing table, loom, stonecutter and the rest.
//   2. The 2x2 inventory grid is client-driven, so the only server-side recourse is
//      to destroy the result after the fact. Crude, but it means an animal gains
//      nothing by crafting, and the message explains why.
ItemEvents.crafted(event => {
    const player = event.entity
    if (!hasEffect(player, 'noCrafting')) return

    try {
        event.item.setCount(0)
        refuse(player, 'An animal cannot craft.')
    } catch (ignored) {
        // if the stack cannot be emptied, the player simply keeps the item
    }
})

// Block placing.
//
// BlockEvents.placed is NO USE for this: its own javadoc says "Invoked when a block
// IS placed" -- it is an after-the-fact notification, so cancelling it reverted the
// block but the item had already left the player's hand.
//
// The interaction itself is the cancellable point. BlockEvents.rightClicked is wired
// to Architectury's InteractionEvent$RightClickBlock (returns an EventResult), and
// placing a block IS a right click on the face of another block. Cancelling there
// stops the whole interaction, so nothing is placed and nothing is consumed.
//
// This handler also covers containers -- both restrictions share the same event, and
// checking them together avoids two hooks racing on one interaction.
// NOTE on cancelling interactions: bare event.cancel() maps to INTERRUPT_DEFAULT,
// which Architectury reads as "no opinion -- carry on with vanilla behaviour". That
// is why cancelling a rightClicked did nothing while reporting success. To actually
// DENY an interaction you must pass a result: event.cancel(false) -> INTERRUPT_FALSE.
BlockEvents.rightClicked(event => {
    const player = event.player
    if (!player) return

    // Read the effects once, then branch. Gating on a single flag coupled the two
    // restrictions together -- see the note on hasEffect().
    const fx = global.SMS.effectsFor(global.SMS.birthRealmOf(player))
    if (!fx.noContainers && !fx.noBlockPlacing) return

    // 1. Containers and workstations: refuse opening them at all.
    if (fx.noContainers && isContainerBlock(event.block.id)) {
        event.cancel(false)
        refuse(player, 'An animal cannot work that.')
        return
    }

    // 2. Block placing: refuse if the player is holding a placeable block.
    if (!fx.noBlockPlacing) return

    try {
        var held = event.item
        if (!held || held.isEmpty()) return

        // Only refuse actual BLOCK items, so food, tools and weapons stay usable and
        // an animal can still eat and fight.
        //
        // `!!Block.getBlock(id)` was WRONG. Block.getAllIds() does not exist, but
        // Block.getBlock() routes through RegistryInfo.BLOCK, and a vanilla registry
        // lookup returns its DEFAULT value -- minecraft:air -- for an id that is not a
        // block, rather than null. air is a truthy object, so this test reported
        // "is a block" for EVERY item: a sword, food, a bucket, everything. The animal
        // realm was refusing all right-click item use, not just placement.
        //
        // Correct test: resolve the id back out of the registry and compare. A real
        // block round-trips to its own id; a non-block resolves to air and does not.
        var isBlockItem = false
        try {
            var heldId = '' + held.id
            var resolved = Block.getBlock(heldId)
            if (resolved) {
                var backId = '' + Block.getId(resolved)
                isBlockItem = backId === heldId && heldId !== 'minecraft:air'
            }
        } catch (e) {
            isBlockItem = false
        }
        if (!isBlockItem) return

        event.cancel(false)
        refuse(player, 'An animal cannot place blocks.')
    } catch (ignored) {
        // if we cannot tell what is held, allow the interaction
    }
})

// SECOND LINE OF DEFENCE.
//
// event.cancel(false) on rightClicked works only INCONSISTENTLY for placement --
// verified in game: one attempt was stopped by the interaction cancel alone, while
// another slipped through and only this hook caught it. Likely an offhand/mainhand
// or client-prediction race.
//
// So both run: the interaction cancel prevents most placements cleanly, and this
// reverts anything that gets through and hands the item back. The player may see a
// brief flicker when the fallback is the one that fires, but nothing is lost.
BlockEvents.placed(event => {
    // event.entity is nullable -- a dispenser or piston placing a block has no entity.
    // hasEffect() already returns false for null, but be explicit: a machine's
    // placement is not a player's and must never be reverted on a player's behalf.
    const player = event.entity
    if (!player) return
    if (!hasEffect(player, 'noBlockPlacing')) return

    try {
        var id = '' + event.block.id
        if (!id || id === 'minecraft:air') return

        event.block.set('minecraft:air')

        // DO NOT REFUND.
        //
        // The previous version called player.give(id) unconditionally, which duplicates
        // the block in creative mode -- the stack is never consumed there, so give()
        // hands back a block the player still holds. Testing happens in creative, so
        // this was easy to hit.
        //
        // There is no way to check the gamemode: grepping the whole jar finds
        // kjs$setCreativeMode (write-only) and no getter at all -- no isCreative, no
        // getGameMode, no GameType accessor. So the mode cannot be branched on.
        //
        // The refund is dropped instead. It only ever mattered when `rightClicked`
        // failed to deny the interaction, which is the inconsistent path, and losing
        // one block in that rare case is far better than a duplication exploit. The
        // message tells the player what happened.
        refuse(player, 'An animal cannot place blocks.')
    } catch (ignored) {
        // if the revert fails the player simply keeps the placed block
    }
})

// ---- Preta (hungry ghost) realm --------------------------------------------
//
// A huge belly and a pinhole mouth: food the preta eats for ITSELF barely registers.
// Once feeding others exists (design doc 7), giving food away will be the efficient
// way to eat, and generosity becomes the escape route rather than a side activity.
//
// TIMING. FoodEatenEventJS fires BEFORE the food is applied, not after.
// LivingEntityMixin injects kjs$foodEaten at @At("HEAD") of LivingEntity.eat()
// (verified by dumping the mixin), so when this handler runs the player's foodLevel
// is still the PRE-meal value and vanilla adds the full nutrition immediately after
// we return. Deferring the correction is the only option -- the event is not
// cancellable and has no post-hook.
//
// WHY WE MEASURE THE MEAL INSTEAD OF READING THE ITEM (verified against the jar,
// 2026-10-18 -- this was a SILENT total failure: eating restored the FULL bar).
// The previous version asked the item how much it would give:
//     nutrition = Number(item.foodProperties.nutrition)
// Nothing in that chain is reachable here, so it threw, the catch set nutrition = 0,
// the `if (!nutrition) return` queued nothing, and the penalty never ran at all.
//   - `event.item` is an ItemStack, and ItemStackKJS has NO food member whatsoever.
//     Its complete kjs$ list is: areItemsEqual asIngredient enchantCopy
//     equalsIgnoringCount getEnchantments getHarvestSpeed getId getIdLocation getMod
//     getNbtString getTags getTypeData hasEnchantment hasTag ignoreNBT isBlock
//     isNBTEqual removeTag self strongNBT toItemString weakNBT withChance withCount
//     withLore withNBT withName. No foodProperties.
//   - `foodProperties` exists only on ItemKJS/ItemMixin and only as a SETTER
//     (kjs$overrideFood, signature (Lnet/minecraft/world/food/FoodProperties;)V --
//     void, takes an argument). There is no getter for a read to remap onto.
//   - The string "nutrition" appears NOWHERE in the KubeJS jar. FoodBuilder calls
//     that field `hunger`, and FoodProperties' own accessors are raw obfuscated
//     names (m_38744_ etc.) on a vanilla object with no read remap.
// So a meal's size cannot be predicted from script. It CAN be measured: snapshot
// foodLevel + saturation at HEAD, read them again next tick, and take back the
// preta's share of whatever vanilla actually added. This uses only proven bean
// members on PlayerKJS (kjs$getFoodLevel / kjs$setFoodLevel / kjs$getSaturation /
// kjs$setSaturation) and it handles modded and custom food for free, which the item
// read never would have.
//
// On global.SMS so global.SMS.clearPreviousLife() can discard a queued penalty when
// the player is reborn. A preta who eats and dies in the same tick must NOT have the
// penalty applied to their next body. Still keyed by uuid string, so the teardown in
// clearPreviousLife needs no change.
global.SMS.pendingFoodPenalty = global.SMS.pendingFoodPenalty || {}

ItemEvents.foodEaten(event => {
    // DIAGNOSTIC LOGGING (config.debugFood). Every exit path below is logged when it
    // is on, because every one of them is a SILENT return: the old version of this
    // hook failed completely and left no trace at all in the log, which is what made
    // it survive a full test round. Off by default -- it is one line per bite.
    var dbg = false
    try {
        dbg = global.SMS.config.debugFood === true
    } catch (ignored) {
        dbg = false
    }

    const player = event.entity
    if (!player || !player.isPlayer()) {
        if (dbg) console.info('[Samsara] foodEaten: entity is not a player; ignored')
        return
    }

    // Liberation turns realm penalties off. This handler cannot use hasEffect()
    // because foodMultiplier is a NUMBER, not a boolean flag, so it needs its own
    // guard -- the preta food penalty would otherwise outlive liberation.
    try {
        if (global.SMS.isLiberated(player)) {
            if (dbg) console.info('[Samsara] foodEaten: player is liberated; no penalty')
            return
        }
    } catch (ignored) {
        // fall through and apply normally
    }

    const realm = global.SMS.birthRealmOf(player)
    const fx = global.SMS.effectsFor(realm)
    const mult = fx.foodMultiplier
    if (mult === undefined || mult >= 1) {
        if (dbg) {
            console.info(
                `[Samsara] foodEaten: born-${realm} has no foodMultiplier (${mult}); full meal`
            )
        }
        return
    }

    try {
        // Snapshot the PRE-meal state. We are at @At("HEAD") of eat(), so these are
        // still the values from before this meal.
        var beforeFood = Number(player.foodLevel)
        if (!isFinite(beforeFood)) {
            // This is the one failure that would be invisible AND fatal to the
            // penalty, so it warns even with the diagnostic off.
            console.warn('[Samsara] foodEaten: player.foodLevel unreadable; penalty skipped')
            return
        }

        var beforeSat = Number(player.saturation)
        if (!isFinite(beforeSat)) beforeSat = 0

        var key = '' + player.uuid

        // If a snapshot is already queued (two meals inside one tick), keep the
        // EARLIER one: it is the true pre-eating baseline for this tick, so the
        // single correction below still reduces both meals to the right level.
        if (global.SMS.pendingFoodPenalty[key] === undefined) {
            global.SMS.pendingFoodPenalty[key] = {
                food: beforeFood,
                sat: beforeSat,
                mult: mult,
            }
            if (dbg) {
                console.info(
                    `[Samsara] foodEaten: queued snapshot for born-${realm}` +
                        ` food=${beforeFood} sat=${beforeSat} mult=${mult}`
                )
            }
        } else if (dbg) {
            console.info('[Samsara] foodEaten: snapshot already queued this tick; kept the earlier one')
        }
    } catch (e) {
        // The old hook's silent catch here is exactly what hid the unreachable
        // nutrition read for a whole test round. Never silent again.
        console.warn(`[Samsara] foodEaten: snapshot failed: ${e}`)
    }
})

// Apply the deferred preta food penalty, one tick after the meal.
//
// Players are found by scanning the online list rather than via server.getPlayer():
// kjs$getPlayer takes a PlayerSelector, not a UUID string (verified in the jar), and
// relying on Rhino to coerce a string into that type is exactly the kind of guess
// that fails silently here. The online list is small, and this only runs on ticks
// where a penalty is actually queued.
// Drain the deferred meal penalties queued by the foodEaten hook above.
//
// Split out of the tick handler so the handler can call it BEFORE the preta ceiling
// without the drain's early returns (empty queue, no player list) skipping the clamp.
global.SMS.drainFoodPenalties = server => {
var keys = Object.keys(global.SMS.pendingFoodPenalty)

    var dbgDrain = false
    try {
        dbgDrain = global.SMS.config.debugFood === true
    } catch (ignored) {
        dbgDrain = false
    }

    var online = null
    try {
        online = server.players
    } catch (ignored) {
        return
    }
    if (!online) {
        return
    }

    for (var i = 0; i < keys.length; i++) {
        var key = keys[i]
        var snap = global.SMS.pendingFoodPenalty[key]
        delete global.SMS.pendingFoodPenalty[key]
        if (!snap) continue

        var player = null
        try {
            for (var j = 0; j < online.size(); j++) {
                var p = online.get(j)
                if (('' + p.uuid) === key) {
                    player = p
                    break
                }
            }
        } catch (ignored) {
            player = null
        }
        if (!player) continue

        try {
            var cur = Number(player.foodLevel)
            if (!isFinite(cur)) {
                console.warn('[Samsara] food drain: foodLevel unreadable; meal kept in full')
                continue
            }

            // Saturation goes entirely, on every path below: a hungry ghost is never
            // satisfied. Done first so an early `continue` cannot skip it.
            var sat = Number(player.saturation)
            if (isFinite(sat) && sat > 0) player.setSaturation(0)

            // What did the meal ACTUALLY restore? Vanilla has finished eating by now.
            var gained = cur - snap.food
            if (!isFinite(gained) || gained <= 0) {
                if (dbgDrain) {
                    console.info(
                        `[Samsara] food drain: no measurable gain (before=${snap.food}` +
                            ` after=${cur}); saturation cleared only`
                    )
                }
                continue // ate on a full bar
            }

            // The preta keeps only `mult` of it. FLOOR, not round, so the penalty can
            // never round UP into a free point. A meal worth less than 1/mult points
            // therefore feeds a preta nothing at all, which is the intent.
            var kept = Math.floor(gained * snap.mult)
            var next = snap.food + kept
            if (next < 0) next = 0
            if (next > cur) next = cur // never ADD food
            player.setFoodLevel(Math.floor(next))

            if (dbgDrain) {
                console.info(
                    `[Samsara] food drain: ${player.profile.name} gained ${gained}` +
                        ` -> kept ${kept} (mult ${snap.mult}); food ${cur} -> ${Math.floor(next)}`
                )
            }
        } catch (e) {
            console.warn(`[Samsara] food drain failed: ${e}`)
        }
    }
}

// ---- The preta tick: drain, THEN clamp ---------------------------------------
//
// ORDER IS LOAD-BEARING, and getting it wrong broke the drain completely.
//
// Observed in game 2026-10-18: "eating cooked beef restores the normal amount, but it
// immediately resets back to 3". The clamp was running FIRST on every 4th tick: it set
// foodLevel to the cap, and the drain then measured `gained = cap - snapshot` = 0 and
// bailed out through its own "ate on a full bar" branch. The ceiling destroyed the
// penalty it was supposed to sit on top of -- the failure mode the project notes warn about,
// where a guard costs the thing it guards.
//
// The cap MASKED this: the bar lands on 3 either way, so the only way to tell the two
// apart is the drain's own log line (config.debugFood).
//
// Draining first is also the right meaning: the drain corrects what THIS MEAL added,
// and the ceiling then enforces the standing limit on the corrected result.
ServerEvents.tick(event => {
    global.SMS.drainFoodPenalties(event.server)

    global.SMS.pretaCounter++
    if (global.SMS.pretaCounter >= PRETA_INTERVAL_TICKS) {
        global.SMS.pretaCounter = 0
        global.SMS.enforcePretaHunger(event.server)
    }
})

// ---- Preta: a capped hunger bar and a permanent hunger effect ----------------
//
// The design: a hungry ghost's bar never rises past `foodCap` (3 icons = 6 points)
// and they carry minecraft:hunger permanently. Together with foodMultiplier above,
// eating is close to pointless for a preta -- which is the realm's whole character.
//
// WHY A CEILING ON A TIMER, NOT A ONE-SHOT SET. Setting foodLevel once at rebirth
// does nothing lasting: the next meal refills the bar, and vanilla's own regen and
// the respawn both reset it to 20. The cap therefore has to be re-enforced. It runs
// on a timer rather than every tick because it is a clamp, not a reaction -- there is
// nothing to miss by checking 5x/second instead of 20x.
//
// WHY /effect AND NOT getPotionEffects().add(). Jar-verified 2026-10-18:
// EntityPotionEffectsJS.add's overloads all take a net.minecraft MobEffect OBJECT
// ((Lnet/minecraft/world/effect/MobEffect;IIZZ)V and friends) -- there is NO
// String-id overload, and BuiltinKubeJSPlugin registers NO MobEffect type wrapper,
// so Rhino has nothing to coerce 'minecraft:hunger' with. That is project trap 8
// (overloads must match exactly) and it fails silently. kjs$runCommandSilent takes a
// plain Ljava/lang/String; (verified on EntityKJS), so the command is the seam that
// actually works from script.
//
// NOTE the /effect command takes SECONDS, while the config carries TICKS (every other
// duration in this pack is in ticks, and mixing the two units is how this goes wrong
// silently). The conversion happens here, once.
//
// THIS LIVES IN THE SAME HANDLER as the meal drain above, deliberately. Two separate
// ServerEvents.tick registrations would leave the order between "take back the meal"
// and "enforce the ceiling" up to registration order, which the project notes' rule about
// handler order being filename order says not to rely on. Running the drain first and
// the clamp second, in one function, makes the sequence explicit.
global.SMS.enforcePretaHunger = server => {
    var players = null
    try {
        players = server.players
    } catch (ignored) {
        return
    }
    if (!players) return

    var size = 0
    try {
        size = players.size()
    } catch (ignored) {
        return
    }
    if (size === 0) return

    for (var i = 0; i < size; i++) {
        var player = null
        try {
            player = players.get(i)
        } catch (ignored) {
            continue
        }
        if (!player) continue

        // Liberation turns realm penalties off. foodCap and hungerEffect are a number
        // and an object, not boolean flags, so hasEffect() does not cover them and
        // they need the same explicit guard the food multiplier does.
        var freed = false
        try {
            freed = global.SMS.isLiberated(player)
        } catch (ignored) {
            freed = false
        }
        if (freed) continue

        var fx = null
        try {
            fx = global.SMS.effectsFor(global.SMS.birthRealmOf(player))
        } catch (ignored) {
            continue
        }
        if (!fx) continue

        // 1. Clamp the hunger bar DOWN to the cap. Never raises it: a starving preta
        //    who has fallen below the cap stays where they are.
        if (fx.foodCap !== undefined) {
            try {
                var cur2 = Number(player.foodLevel)
                if (isFinite(cur2) && cur2 > fx.foodCap) {
                    player.setFoodLevel(Math.floor(fx.foodCap))
                    // Saturation above the cap would refill the bar straight back up,
                    // so it goes too -- vanilla drains saturation before food.
                    var sat2 = Number(player.saturation)
                    if (isFinite(sat2) && sat2 > 0) player.setSaturation(0)
                }
            } catch (ignored) {
                // food members unreadable; skip this player this pass
            }
        }

        // 2. Renew the hunger effect before it lapses, so the icon never flickers.
        if (fx.hungerEffect) {
            try {
                var he = fx.hungerEffect
                var seconds = Math.ceil(Number(he.durationTicks) / 20)
                if (!isFinite(seconds) || seconds < 1) seconds = 1
                var amp = Number(he.amplifier)
                if (!isFinite(amp) || amp < 0) amp = 0
                // `true` is hideParticles: a permanent effect should not fog the
                // screen with particles forever.
                player.runCommandSilent(
                    'effect give @s ' + he.id + ' ' + seconds + ' ' + amp + ' true'
                )
            } catch (ignored) {
                // command seam unavailable; nothing else to try
            }
        }
    }
}

// SECOND LINE OF DEFENCE FOR CONTAINERS.
//
// BlockEvents.rightClicked is the only cancellable hook for opening a container, and
// the handoff records it working only INCONSISTENTLY for placement (one attempt
// blocked, the next slipping through). There is no reason to assume containers are
// immune to the same race, and "an animal opened a chest" is exactly the symptom that
// was reported.
//
// Neither PlayerEvents.inventoryOpened nor ChestEventJS is cancellable -- verified by
// dumping InventoryEventJS and ChestEventJS, neither has a cancel member. But
// `closeMenu` IS reachable: PlayerMixin carries @RemapForJS m_6915_ -> closeMenu.
//
// So if a container menu does open for a restricted player, shut it immediately. The
// player may see a single frame of the GUI, which matches the placement fallback's
// behaviour and is acceptable for a restriction that must hold.
PlayerEvents.inventoryOpened(event => {
    const player = event.entity
    if (!player) return
    if (!hasEffect(player, 'noContainers')) return

    // The player's OWN inventory also fires this event and must stay usable -- an
    // animal still carries items.
    //
    // InventoryEventJS exposes only getEntity and getInventoryContainer; there is NO
    // getBlock on it (that exists only on ChestEventJS), so the backing block cannot
    // be inspected here. Distinguish by the menu's CLASS NAME instead: the player's
    // own inventory is an InventoryMenu, every block container is something else
    // (ChestMenu, FurnaceMenu, ...).
    var menuName = ''
    try {
        menuName = '' + event.inventoryContainer.getClass().getSimpleName()
    } catch (ignored) {
        // cannot identify the menu -- do nothing rather than risk locking a player
        // out of their own inventory.
        return
    }
    if (!menuName || menuName === 'InventoryMenu') return

    try {
        player.closeMenu()
        refuse(player, 'An animal cannot work that.')
    } catch (e) {
        // closeMenu unavailable: the rightClicked cancel is the only protection.
    }
})

console.info('[Samsara] realm effects registered')
