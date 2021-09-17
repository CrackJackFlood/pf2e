import { CharacterPF2e, CreaturePF2e } from "@actor";
import { SpellPF2e } from "@item/spell";
import { OneToTen, ZeroToTen } from "@module/data";
import { groupBy, ErrorPF2e } from "@module/utils";
import { ItemPF2e } from "../base";
import { SlotKey, SpellcastingEntryData } from "./data";

export interface SpellcastingSlotLevel {
    label: string;
    level: ZeroToTen;
    isCantrip: boolean;

    /**
     * Number of uses and max slots or spells.
     * If this is null, allowed usages are infinite.
     * If value is undefined then it's not expendable, it's a count of total spells instead.
     */
    uses?: {
        value?: number;
        max: number;
    };

    displayPrepared?: boolean;
    active: (ActiveSpell | null)[];
}

interface SpellPrepEntry {
    spell: Embedded<SpellPF2e>;
    chatData: Record<string, unknown>;
    signature?: boolean;
}

interface ActiveSpell {
    spell: Embedded<SpellPF2e>;
    chatData: Record<string, unknown>;
    expended?: boolean;
    /** Is this spell marked as signature/collection */
    signature?: boolean;
    /** Is the spell not actually of this level? */
    virtual?: boolean;
}

export class SpellcastingEntryPF2e extends ItemPF2e {
    static override get schema(): typeof SpellcastingEntryData {
        return SpellcastingEntryData;
    }

    private _spells: Collection<Embedded<SpellPF2e>> | null = null;

    /** A collection of all spells contained in this entry regardless of organization */
    get spells() {
        if (!this._spells) {
            this._spells = new Collection<Embedded<SpellPF2e>>();
            if (this.actor) {
                const spells = this.actor.itemTypes.spell.filter((i) => i.data.data.location.value === this.id);
                for (const spell of spells) {
                    this._spells.set(spell.id, spell);
                }
            }
        }

        return this._spells;
    }

    get ability() {
        return this.data.data.ability.value || "int";
    }

    get tradition() {
        return this.data.data.tradition.value || null;
    }

    /**
     * Returns the proficiency used for calculations.
     * For innate spells, this is the highest spell proficiency (min trained)
     */
    get rank() {
        const actor = this.actor;
        if (actor instanceof CharacterPF2e && this.isInnate) {
            const allRanks = actor.itemTypes.spellcastingEntry.map((entry) => entry.data.data.proficiency.value ?? 0);
            return Math.max(1, ...allRanks);
        }

        return this.data.data.proficiency.value ?? 0;
    }

    get isPrepared(): boolean {
        return this.data.data.prepared.value === "prepared";
    }

    get isFlexible(): boolean {
        return this.isPrepared && !!this.data.data.prepared.flexible;
    }

    get isSpontaneous(): boolean {
        return this.data.data.prepared.value === "spontaneous";
    }

    get isInnate(): boolean {
        return this.data.data.prepared.value === "innate";
    }

    get isFocusPool(): boolean {
        return this.data.data.prepared.value === "focus";
    }

    get isRitual(): boolean {
        return this.data.data.prepared.value === "ritual";
    }

    get highestLevel(): number {
        const highestSpell = Math.max(...this.spells.map((s) => s.heightenedLevel));
        const actorSpellLevel = Math.ceil((this.actor?.level ?? 0) / 2);
        return Math.min(10, Math.max(highestSpell, actorSpellLevel));
    }

    override prepareData() {
        super.prepareData();

        // Wipe the internal spells collection so it can be rebuilt later.
        // We can't build the spells collection here since actor.items might not be populated
        this._spells = null;
    }

    /**
     * Adds a spell to this spellcasting entry, either moving it from another one if its the same actor,
     * or creating a new spell if its not.
     */
    async addSpell(spell: SpellPF2e, targetLevel: number) {
        const actor = this.actor;
        if (!(actor instanceof CreaturePF2e)) {
            throw ErrorPF2e("Spellcasting entries can only exist on creatures");
        }

        const spellcastingEntryId = spell.data.data.location.value;
        if (spellcastingEntryId === this.id && spell.heightenedLevel === targetLevel) {
            return [];
        }

        const spellData = spell.toObject(true);
        spellData.data.location.value = this.id;

        if (!spell.isCantrip && !spell.isFocusSpell && !spell.isRitual) {
            if (this.isSpontaneous || this.isInnate) {
                spellData.data.heightenedLevel = { value: Math.max(spell.level, targetLevel) };
            }
        }

        if (spell.actor?.id === actor.id) {
            const results = await actor.updateEmbeddedDocuments("Item", [spellData]);
            return results as ItemPF2e[];
        } else {
            const results = await actor.createEmbeddedDocuments("Item", [spellData]);
            return results as ItemPF2e[];
        }
    }

    /** Saves the prepared spell slot data to the spellcasting entry  */
    prepareSpell(spell: SpellPF2e, spellLevel: number, spellSlot: number) {
        if (spell.level > spellLevel && !(spellLevel === 0 && spell.isCantrip)) {
            console.warn(`Attempted to add level ${spell.level} spell to level ${spellLevel} spell slot.`);
            return;
        }

        if (CONFIG.debug.hooks) {
            console.debug(
                `PF2e System | Updating location for spell ${spell.name} to match spellcasting entry ${this.id}`
            );
        }

        const key = `data.slots.slot${spellLevel}.prepared.${spellSlot}`;
        const updates: Record<string, unknown> = { [key]: { id: spell.id } };

        const slot = this.data.data.slots[`slot${spellLevel}` as SlotKey].prepared[spellSlot];
        if (slot) {
            if (slot.prepared !== undefined) {
                updates[`${key}.-=prepared`] = null;
            }
            if (slot.name !== undefined) {
                updates[`${key}.-=name`] = null;
            }
            if (slot.expended !== undefined) {
                updates[`${key}.-=expended`] = null;
            }
        }

        return this.update(updates);
    }

    /** Removes the spell slot and updates the spellcasting entry */
    unprepareSpell(spellLevel: number, spellSlot: number) {
        if (CONFIG.debug.hooks === true) {
            console.debug(
                `PF2e System | Updating spellcasting entry ${this.id} to remove spellslot ${spellSlot} for spell level ${spellLevel}`
            );
        }

        const key = `data.slots.slot${spellLevel}.prepared.${spellSlot}`;
        return this.update({
            [key]: {
                name: game.i18n.localize("PF2E.SpellSlotEmpty"),
                id: null,
                prepared: false,
            },
        });
    }

    /** Sets the expended state of a spell slot and updates the spellcasting entry */
    setSlotExpendedState(spellLevel: number, spellSlot: number, isExpended: boolean) {
        const key = `data.slots.slot${spellLevel}.prepared.${spellSlot}.expended`;
        return this.update({ [key]: isExpended });
    }

    /** Returns rendering data to display the spellcasting entry in the sheet */
    getSpellData(this: Embedded<SpellcastingEntryPF2e>) {
        if (!(this.actor instanceof CreaturePF2e)) {
            throw ErrorPF2e("Spellcasting entries can only exist on creatures");
        }

        const results: SpellcastingSlotLevel[] = [];
        const spellPrepList: Record<number, SpellPrepEntry[]> = {};
        const spells = this.spells.contents.sort((s1, s2) => (s1.data.sort || 0) - (s2.data.sort || 0));
        const signatureSpells = new Set(this.data.data.signatureSpells?.value ?? []);

        if (this.isPrepared) {
            // Prepared Spells. Start by fetch the prep list. Active spells are what's been prepped.
            const spellsByLevel = groupBy(spells, (spell) => (spell.isCantrip ? 0 : spell.level));
            for (let level = 0; level <= this.highestLevel; level++) {
                const data = this.data.data.slots[`slot${level}` as SlotKey];

                // Detect which spells are active. If flexible, it will be set later via signature spells
                const active: (ActiveSpell | null)[] = [];
                if ((this.data.data.showSlotlessLevels.value || data.max > 0) && (level === 0 || !this.isFlexible)) {
                    const maxPrepared = Math.max(data.max, 0);
                    active.push(...Array(maxPrepared).fill(null));
                    for (const [key, value] of Object.entries(data.prepared)) {
                        const spell = value.id ? this.spells.get(value.id) : null;
                        if (spell) {
                            active[Number(key)] = {
                                spell,
                                chatData: spell.getChatData(),
                                expended: value.expended,
                            };
                        }
                    }
                }

                // Build the prep list
                spellPrepList[level] =
                    spellsByLevel.get(level as ZeroToTen)?.map((spell) => ({
                        spell,
                        chatData: spell.getChatData(),
                        signature: this.isFlexible && signatureSpells.has(spell.id),
                    })) ?? [];

                results.push({
                    label: level === 0 ? "PF2E.TraitCantrip" : CONFIG.PF2E.spellLevels[level as OneToTen],
                    level: level as ZeroToTen,
                    uses: {
                        value: level > 0 && this.isFlexible ? data.value || 0 : undefined,
                        max: data.max,
                    },
                    isCantrip: level === 0,
                    active,
                    displayPrepared:
                        this.data.data.displayLevels && this.data.data.displayLevels[level] !== undefined
                            ? this.data.data.displayLevels[level]
                            : true,
                });
            }
        } else if (this.isFocusPool) {
            // Focus Spells. All non-cantrips are grouped together as they're auto-scaled
            const cantrips = spells.filter((spell) => spell.isCantrip);
            const leveled = spells.filter((spell) => !spell.isCantrip);

            if (cantrips.length) {
                results.push({
                    label: "PF2E.TraitCantrip",
                    level: 0,
                    isCantrip: true,
                    active: cantrips.map((spell) => ({ spell, chatData: spell.getChatData() })),
                });
            }

            if (leveled.length) {
                results.push({
                    label: "PF2E.Focus.label",
                    level: Math.max(1, Math.ceil(this.actor.level / 2)) as OneToTen,
                    isCantrip: false,
                    uses: this.actor.data.data.resources.focus ?? { value: 0, max: 0 },
                    active: leveled.map((spell) => ({ spell, chatData: spell.getChatData() })),
                });
            }
        } else {
            // Everything else (Innate/Spontaneous/Ritual)
            const alwaysShowHeader = !this.isRitual;
            const spellsByLevel = groupBy(spells, (spell) => (spell.isCantrip ? 0 : spell.heightenedLevel));
            for (let level = 0; level <= this.highestLevel; level++) {
                const data = this.data.data.slots[`slot${level}` as SlotKey];
                const spells = spellsByLevel.get(level) ?? [];
                // todo: innate spells should be able to expend like prep spells do
                if (alwaysShowHeader || spells.length) {
                    const uses = this.isRitual || level === 0 ? undefined : { value: data.value, max: data.max };
                    const active = spells.map((spell) => ({ spell, chatData: spell.getChatData() }));

                    // Spontaneous spellbooks hide their levels if there are no uses for them. Innate hide if there are no active spells.
                    const hideForSpontaneous = this.isSpontaneous && uses?.max === 0;
                    const hideForInnate = this.isInnate && active.length === 0;
                    if (!this.data.data.showSlotlessLevels.value && (hideForSpontaneous || hideForInnate)) continue;

                    results.push({
                        label: level === 0 ? "PF2E.TraitCantrip" : CONFIG.PF2E.spellLevels[level as OneToTen],
                        level: level as ZeroToTen,
                        isCantrip: level === 0,
                        uses,
                        active,
                    });
                }
            }
        }

        // Handle signature spells
        if (this.isSpontaneous || this.isFlexible) {
            for (const spellId of signatureSpells) {
                const spell = this.spells.get(spellId);
                if (!spell) continue;

                for (const result of results) {
                    if (spell.level > result.level) continue;
                    if (!this.data.data.showSlotlessLevels.value && result.uses?.max === 0) continue;

                    const existing = result.active.find((a) => a?.spell.id === spellId);
                    if (existing) {
                        existing.signature = true;
                    } else {
                        const chatData = spell.getChatData({}, { spellLvl: result.level });
                        result.active.push({ spell, chatData, signature: true, virtual: true });
                    }
                }
            }
        }

        // If flexible, the limit is the number of slots, we need to notify the user
        const flexibleAvailable = (() => {
            if (!this.isFlexible) return undefined;
            const totalSlots = results
                .filter((result) => !result.isCantrip)
                .map((level) => level.uses?.max || 0)
                .reduce((first, second) => first + second, 0);
            return { value: signatureSpells.size, max: totalSlots };
        })();

        return {
            id: this.id,
            name: this.name,
            tradition: this.tradition,
            castingType: this.data.data.prepared.value,
            isPrepared: this.isPrepared,
            isSpontaneous: this.isSpontaneous,
            isFlexible: this.isFlexible,
            isInnate: this.isInnate,
            isFocusPool: this.isFocusPool,
            isRitual: this.isRitual,
            flexibleAvailable,
            levels: results,
            spellPrepList,
        };
    }

    protected override async _preUpdate(
        data: DeepPartial<this["data"]["_source"]>,
        options: DocumentModificationContext,
        user: foundry.documents.BaseUser
    ) {
        // Clamp slot updates
        if (data.data?.slots) {
            for (const key of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
                const slotKey = `slot${key}` as const;
                const slotData = data.data.slots[slotKey];
                if (!slotData) continue;

                if ("max" in slotData) {
                    slotData.max = Math.max(Number(slotData.max) || 0, 0);
                }
                if ("value" in slotData) {
                    const max = "max" in slotData ? Number(slotData?.max) || 0 : this.data.data.slots[slotKey].max;
                    slotData.value = Math.clamped(Number(slotData.value), 0, max);
                }
            }
        }

        await super._preUpdate(data, options, user);
    }
}

export interface SpellcastingEntryPF2e {
    readonly data: SpellcastingEntryData;
}
