"use client";

// Combos checklist dropdown — one popover per model row. The trigger reads the
// model's current combo membership (or its pending edit), the popover lists every
// combo as a Checkbox row with a search box, so ticking several combos with 30-50
// of them is a click per combo instead of a Ctrl+click inside a native listbox.

import { useId, useMemo, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@omniroute/ui-kit/popover";
import Button from "@/shared/components/Button";
import Icon from "@/shared/components/Icon";
import Checkbox from "@/shared/components/Checkbox";
import { matchesSearch } from "@/shared/utils/turkishText";

export interface ComboChecklistOption {
  id: string;
  name: string;
}

interface ComboMembershipSelectProps {
  options: ComboChecklistOption[];
  selectedIds: string[];
  onChange: (nextIds: string[]) => void;
  disabled?: boolean;
  /** Accessible name for the trigger and the popover dialog. */
  ariaLabel: string;
  searchPlaceholder?: string;
}

export default function ComboMembershipSelect({
  options,
  selectedIds,
  onChange,
  disabled = false,
  ariaLabel,
  searchPlaceholder = "Search combos…",
}: ComboMembershipSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const menuId = useId();

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleOptions = useMemo(() => {
    if (!query.trim()) return options;
    return options.filter((option) => matchesSearch(`${option.name} ${option.id}`, query));
  }, [options, query]);

  const summary =
    selected.size === 0
      ? "Not in any combo"
      : [...selected].length === 1
        ? (options.find((option) => option.id === [...selected][0])?.name ?? "1 combo")
        : `${selected.size} combos`;

  const toggleOption = (id: string) => {
    const next = selected.has(id) ? [...selected].filter((value) => value !== id) : [...selected, id];
    onChange(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={ariaLabel}
          className="ci-multi-select-filter__trigger"
        >
          <span className="ci-multi-select-filter__value">
            <span className="ci-multi-select-filter__option-label">
              <span>{summary}</span>
            </span>
          </span>
          <Icon name={open ? "expand_less" : "expand_more"} size={14} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        id={menuId}
        role="dialog"
        aria-label={ariaLabel}
        align="start"
        sideOffset={4}
        className="ci-multi-select-filter__popover w-72"
      >
        <div className="ci-multi-select-filter__search">
          <Icon name="search" size={14} />
          <input
            type="text"
            role="searchbox"
            inputMode="search"
            autoFocus
            className="ci-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear combos search"
              onClick={() => setQuery("")}
              className="ci-multi-select-filter__clear"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <button
            type="button"
            className="text-xs font-medium text-text-muted hover:text-text-main"
            onClick={() => onChange(options.map((option) => option.id))}
          >
            Select all
          </button>
          <button
            type="button"
            className="text-xs font-medium text-text-muted hover:text-text-main"
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
        <div role="group" aria-label={ariaLabel} className="ci-multi-select-filter__options">
          {visibleOptions.map((option) => {
            const checked = selected.has(option.id);
            return (
              <div
                key={option.id}
                className="ci-multi-select-filter__option"
                data-selected={checked || undefined}
              >
                <Checkbox
                  checked={checked}
                  onChange={() => toggleOption(option.id)}
                  label={<span className="ci-multi-select-filter__option-label">{option.name}</span>}
                />
              </div>
            );
          })}
          {visibleOptions.length === 0 && (
            <p className="ci-multi-select-filter__empty">No combos match your search.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}