// Samsara — the four effects Samsara registers itself:
//   samsara:aging                   EVERY life's clock (2026-10-25)
//   samsara:insatiable_craving      the preta's (the Hungry Ghost until 2026-10-24)
//   samsara:radiance_of_the_blessed the deva's (2026-10-24)
//   samsara:self_wrought_torment    the naraka-born's (2026-10-24)
//
// AGING (decided 2026-10-25, the user) is the ONLY timed effect in the pack. Every birth
// wears it, in every realm; its timer is what is left of this life (config.aging), and
// when it runs out the player dies of old age (samsara_realms.js). It does nothing on its
// own: the clock is Samsara's, and the effect is drawn from it. NEUTRAL, so nothing that
// cleanses harmful effects strips it.
//
// The three realm effects are given with NO end (`/effect give ... infinite`) for the whole
// life, and each is the ONE entry its realm shows in the inventory (the user, 2026-10-25:
// "fold all into one for all rebirth types"). What a vanilla effect does through an
// attribute is a modifier here; what it does through code (healing, hunger, fire, damage)
// is Samsara's realm rules (config.realmEffects), which follow birthRealm, not the effect.
//
// INSATIABLE CRAVING. Decided 2026-10-22 (the user) in place of Corail Tombstone's Ghostly
// Shape. That effect is a respawn grace: once a second its tick refills the food bar,
// zeroes exhaustion, heals and clears every harmful effect (read from
// tombstone-neoforge-1.21.1-9.5.6) -- it would have undone the very hunger a preta is.
// NEUTRAL, carrying vanilla Slowness I and Weakness I; its Hunger I is
// realmEffects.preta.exhaustion. What a ghost IS -- nothing harms it, nothing hunts it --
// is Samsara's realm rules. Renamed 2026-10-24 (the user); the id changed with the name.
//
// RADIANCE OF THE BLESSED, BENEFICIAL, carries Speed I, Haste I, Jump Boost I, Luck, Water
// Breathing and Absorption IV's golden-heart capacity. Regeneration II, Resistance I, Fire
// Resistance and the hearts themselves are realmEffects.deva. SELF-WROUGHT TORMENT,
// HARMFUL, carries Slowness I, Weakness I and Mining Fatigue I; its Hunger I and its
// withering are realmEffects.naraka.
//
// From the installed KubeJS 7 jar (build 377): BuiltinKubeJSPlugin registers a default
// builder for Registries.MOB_EFFECT (MobEffectBuilder). It starts NEUTRAL with no tick
// callback; beneficial() / harmful() set the category. modifyAttribute(attribute,
// modifier id, amount, operation) is applied while the effect is on the entity -- vanilla
// adds the modifiers when the effect is added and removes them when it ends. Each modifier
// scales by (amplifier + 1), and Samsara gives amplifier 0. displayName(Component) is
// BuilderBase's: without it the lang entry is the id path in title case.
//
// THE NUMBERS ARE VANILLA'S, read from the 1.21.1 MobEffects and Player (2026-10-25):
//   Slowness I          generic.movement_speed   -0.15 ADD_MULTIPLIED_TOTAL
//   Speed I             generic.movement_speed   +0.2  ADD_MULTIPLIED_TOTAL
//   Weakness I          generic.attack_damage    -4    ADD_VALUE
//   Haste I             generic.attack_speed     +0.1  ADD_MULTIPLIED_TOTAL, and digging
//                       x1.2 in Player.getDestroySpeed -> player.block_break_speed +0.2
//                       ADD_MULTIPLIED_TOTAL (the attribute multiplies the same speed)
//   Mining Fatigue I    generic.attack_speed     -0.1  ADD_MULTIPLIED_TOTAL, and digging
//                       x0.3 -> player.block_break_speed -0.7 ADD_MULTIPLIED_TOTAL
//   Jump Boost I        generic.safe_fall_distance +1 ADD_VALUE, and +0.1 jump power
//                       (LivingEntity.getJumpBoostPower) -> generic.jump_strength +0.1
//                       ADD_VALUE (getJumpPower adds the attribute to the same sum)
//   Luck                generic.luck             +1    ADD_VALUE
//   Absorption IV       generic.max_absorption   +4 per level = +16 ADD_VALUE
//   Water Breathing     (code) -> generic.oxygen_bonus +1024 ADD_VALUE, its maximum: an
//                       air point is lost with chance 1/(bonus + 1)
//                       (LivingEntity.decreaseAirSupply)
// (1.21.1 attribute ids still carry the "generic." / "player." prefix.)
//
// The icons are kubejs/assets/samsara/textures/mob_effect/<id path>.png.
//
// Startup scripts run ONCE, at game launch: adding or editing this file needs a game
// restart, not /reload.

const ResourceLocationClass = Java.loadClass('net.minecraft.resources.ResourceLocation')
const OperationClass = Java.loadClass('net.minecraft.world.entity.ai.attributes.AttributeModifier$Operation')
// By dot access: bracket notation on a Java class is not trusted on Rhino (project rule 1).
const ADD_VALUE = OperationClass.ADD_VALUE
const ADD_MULTIPLIED_TOTAL = OperationClass.ADD_MULTIPLIED_TOTAL

// Add each [attribute, modifier name, amount, operation] to the builder `b`, the modifier
// id `samsara:<effect>_<name>`.
function withModifiers(b, effect, mods) {
    for (var i = 0; i < mods.length; i++) {
        var m = mods[i]
        b.modifyAttribute(
            ResourceLocationClass.parse('minecraft:' + m[0]),
            ResourceLocationClass.parse('samsara:' + effect + '_' + m[1]),
            m[2],
            m[3]
        )
    }
    return b
}

StartupEvents.registry('mob_effect', event => {
    event
        .create('samsara:aging')
        .displayName(Text.of('Aging'))
    withModifiers(event.create('samsara:insatiable_craving').displayName(Text.of('Insatiable Craving')), 'insatiable_craving', [
        ['generic.movement_speed', 'slowness', -0.15, ADD_MULTIPLIED_TOTAL],
        ['generic.attack_damage', 'weakness', -4.0, ADD_VALUE],
    ])
    withModifiers(event.create('samsara:radiance_of_the_blessed').displayName(Text.of('Radiance of the Blessed')).beneficial(), 'radiance_of_the_blessed', [
        ['generic.movement_speed', 'speed', 0.2, ADD_MULTIPLIED_TOTAL],
        ['generic.attack_speed', 'haste', 0.1, ADD_MULTIPLIED_TOTAL],
        ['player.block_break_speed', 'haste_dig', 0.2, ADD_MULTIPLIED_TOTAL],
        ['generic.jump_strength', 'jump_boost', 0.1, ADD_VALUE],
        ['generic.safe_fall_distance', 'jump_boost_fall', 1.0, ADD_VALUE],
        ['generic.luck', 'luck', 1.0, ADD_VALUE],
        ['generic.oxygen_bonus', 'water_breathing', 1024.0, ADD_VALUE],
        ['generic.max_absorption', 'absorption', 16.0, ADD_VALUE],
    ])
    withModifiers(event.create('samsara:self_wrought_torment').displayName(Text.of('Self-wrought Torment')).harmful(), 'self_wrought_torment', [
        ['generic.movement_speed', 'slowness', -0.15, ADD_MULTIPLIED_TOTAL],
        ['generic.attack_damage', 'weakness', -4.0, ADD_VALUE],
        ['generic.attack_speed', 'mining_fatigue', -0.1, ADD_MULTIPLIED_TOTAL],
        ['player.block_break_speed', 'mining_fatigue_dig', -0.7, ADD_MULTIPLIED_TOTAL],
    ])
})
