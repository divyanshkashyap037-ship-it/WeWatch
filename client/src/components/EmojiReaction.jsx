"use client";

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../lib/utils.js';

// Native-emoji port of the pasted Rare-UI-style picker.
// Same burst physics + hold-to-spam, no 380kb emoji JSON needed.
export const EMOJI_MAP = {
  'smiling-face-with-hearts': '🥰',
  'star-struck': '🤩',
  'confused-face': '😕',
  'pleading-face': '🥺',
  'grinning-face-with-smiling-eyes': '😄'
};

const DEFAULT_EMOJIS = Object.keys(EMOJI_MAP);
const SURFACE = 'bg-[#1c1c1e] border border-white/10';
const BURST_COUNT = 5;
const HOLD_INTERVAL = 550;
const MAX_PARTICLES = 60;
const RISE = 450;
const LAUNCH_SPREAD = 6;
const CLIMB_SPREAD = 78;
const EASE = [0.4, 0.3, 0.5, 1];
const SWAY = [0, 0.3, 0.65, 1];
const GAP = 16;
const EDGE = 8;

const SIZES = {
  sm: { trigger: 'size-8', icon: 'size-4', emoji: 26, pill: 'gap-0.5 p-1', burst: 26 },
  md: { trigger: 'size-10', icon: 'size-5', emoji: 34, pill: 'gap-1 p-1.5', burst: 34 },
  lg: { trigger: 'size-12', icon: 'size-6', emoji: 42, pill: 'gap-1.5 p-2', burst: 42 }
};

function SmileIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M21 12a9 9 0 1 1-9-9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="8.9" cy="10" r="1.35" fill="currentColor" />
      <circle cx="15.1" cy="10" r="1.35" fill="currentColor" />
      <path d="M8 13.9a4.7 4.7 0 0 0 8 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M19 2.5v5M21.5 5h-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

const rand = (min, max) => min + Math.random() * (max - min);
const label = (name) => name.replaceAll('-', ' ');

function getPlacement(trigger, width, height, align) {
  const anchored = align === 'left' ? trigger.left : align === 'right' ? trigger.right - width : trigger.left + trigger.width / 2 - width / 2;
  const overhangLeft = EDGE - anchored;
  const overhangRight = anchored + width - (window.innerWidth - EDGE);
  const shift = overhangLeft > 0 ? overhangLeft : overhangRight > 0 ? -overhangRight : 0;
  return {
    side: trigger.top - height - GAP < EDGE ? 'bottom' : 'top',
    shift,
    tailX: trigger.left + trigger.width / 2 - (anchored + shift)
  };
}

function makeParticles(name, seed, from, bar) {
  const originX = from.left + from.width / 2 - bar.left;
  const originY = from.top + from.height / 2 - bar.top;
  return Array.from({ length: BURST_COUNT }, (_, i) => {
    const lane = rand(-1, 1);
    const dir = lane < 0 ? -1 : 1;
    return {
      id: seed + i, name, originX, originY,
      x: lane * LAUNCH_SPREAD,
      drift: lane * CLIMB_SPREAD,
      tilt: rand(1, 4) * dir,
      travel: RISE * rand(0.86, 1),
      scale: rand(0.78, 1.05),
      blurRatio: rand(0.18, 0.3),
      fadeAt: rand(0.55, 0.88),
      duration: rand(1.4, 1.8),
      delay: i * 0.25
    };
  });
}

const BurstEmoji = memo(function BurstEmoji({ particle, size, onDone }) {
  const char = EMOJI_MAP[particle.name] || particle.name;
  return (
    <motion.span
      className="pointer-events-none absolute z-0 will-change-transform"
      style={{ left: particle.originX, top: particle.originY, marginLeft: -size / 2, marginTop: -size / 2, fontSize: size }}
      initial={{ x: particle.x, y: 0, scale: 0.6, opacity: 0, rotate: 0, filter: 'blur(0px)' }}
      animate={{
        x: particle.x + particle.drift,
        y: -particle.travel,
        scale: [0.6, particle.scale * 1.15, particle.scale, particle.scale * 0.75],
        rotate: [0, particle.tilt, -particle.tilt * 0.65, particle.tilt * 0.35],
        opacity: [0, 1, 1, 0],
        filter: ['blur(0px)', 'blur(0px)', `blur(${particle.blurRatio * size}px)`]
      }}
      transition={{
        duration: particle.duration, delay: particle.delay, ease: EASE,
        rotate: { inherit: true, times: SWAY, ease: 'easeInOut' },
        scale: { inherit: true, times: [0, 0.1, 0.22, 1], ease: 'easeOut' },
        opacity: { inherit: true, times: [0, 0.03, particle.fadeAt, 1], ease: 'linear' },
        filter: { inherit: true, times: [0, 0.12, 1] }
      }}
      onAnimationComplete={() => onDone(particle.id)}
    >
      {char}
    </motion.span>
  );
});

export function EmojiReaction({ emojis = DEFAULT_EMOJIS, onReact, size = 'md', align = 'center', asChild = false, className, children, ...props }) {
  const s = SIZES[size];
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(null);
  const [particles, setParticles] = useState([]);
  const [placement, setPlacement] = useState({ side: 'top', shift: 0, tailX: 0 });
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const seed = useRef(0);
  const hold = useRef(null);
  const justOpened = useRef(false);
  const pointerFired = useRef(false); // exactly-once per press: pointerdown fires, click skips

  const setTriggerRef = useCallback((node) => { triggerRef.current = node; }, []);
  const stopHold = useCallback(() => {
    if (hold.current === null) return;
    window.clearInterval(hold.current);
    hold.current = null;
  }, []);
  const close = useCallback(() => { stopHold(); setOpen(false); setParticles([]); }, [stopHold]);

  const placeBar = useCallback((node) => {
    barRef.current = node;
    const trigger = triggerRef.current;
    if (!node || !trigger) return;
    setPlacement(getPlacement(trigger.getBoundingClientRect(), node.offsetWidth, node.offsetHeight, align));
  }, [align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => { if (!rootRef.current?.contains(e.target)) close(); };
    const onKeyDown = (e) => { if (e.key !== 'Escape') return; close(); triggerRef.current?.focus(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [open, close]);

  useEffect(() => { if (open) itemRefs.current[0]?.focus(); }, [open]);

  const react = useCallback((name, from) => {
    setLast(name);
    onReact?.(name);
    const bar = barRef.current?.getBoundingClientRect();
    if (reduced || !bar) return;
    seed.current += BURST_COUNT;
    setParticles((prev) => [...prev, ...makeParticles(name, seed.current, from, bar)].slice(-MAX_PARTICLES));
  }, [onReact, reduced]);

  const startHold = useCallback((name, from) => {
    pointerFired.current = true;
    react(name, from);
    stopHold();
    hold.current = window.setInterval(() => react(name, from), HOLD_INTERVAL);
  }, [react, stopHold]);

  const onEmojiClick = useCallback((name, el) => {
    // mouse/touch already fired via pointerdown; keyboard (and any
    // no-pointer device) arrives here with no prior pointerdown
    if (pointerFired.current) { pointerFired.current = false; return; }
    react(name, el.getBoundingClientRect());
  }, [react]);

  useEffect(() => stopHold, [stopHold]);
  const settle = useCallback((id) => { setParticles((prev) => prev.filter((p) => p.id !== id)); }, []);

  const onTriggerPointerDown = useCallback(() => {
    if (open) return;
    setOpen(true);
    justOpened.current = true;
    const up = (e) => {
      document.removeEventListener('pointerup', up);
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const picked = target?.closest?.('[data-emoji]');
      if (picked?.dataset.emoji) react(picked.dataset.emoji, picked.getBoundingClientRect());
      if (!triggerRef.current?.contains(target)) justOpened.current = false;
    };
    document.addEventListener('pointerup', up);
  }, [open, react]);

  const onMenuKeyDown = useCallback((e) => {
    const count = emojis.length;
    let next = activeIndex;
    if (e.key === 'ArrowRight') next = (activeIndex + 1) % count;
    else if (e.key === 'ArrowLeft') next = (activeIndex - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  }, [activeIndex, emojis.length]);

  const burst = particles.map((p) => <BurstEmoji key={p.id} particle={p} size={s.burst} onDone={settle} />);
  const Trigger = asChild ? Slot : 'button';
  const top = placement.side === 'top';
  const anchor = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2';
  const centering = align === 'center' ? '-50%' : 0;
  const nudge = align === 'right' ? { marginRight: -placement.shift } : { marginLeft: placement.shift };

  return (
    <div ref={rootRef} data-slot="emoji-reaction" className={cn('relative flex w-fit items-center', className)} {...props}>
      <AnimatePresence>
        {open && (
          <motion.div
            className={cn('absolute z-30', anchor, top ? 'bottom-full mb-4' : 'top-full mt-4')}
            initial={{ opacity: 0, y: top ? 10 : -10, scale: 0.85, x: centering }}
            animate={{ opacity: 1, y: 0, scale: 1, x: centering }}
            exit={{ opacity: 0, y: top ? 6 : -6, scale: 0.9, x: centering }}
            transition={reduced ? { duration: 0.15 } : { type: 'spring', stiffness: 520, damping: 30 }}
            style={{ originY: top ? 1 : 0, ...nudge }}
          >
            <div ref={placeBar} role="menu" aria-label="Pick a reaction" onKeyDown={onMenuKeyDown} className={cn('relative flex items-center rounded-full', SURFACE, s.pill)}>
              {burst}
              {emojis.map((name, i) => (
                <motion.button
                  key={`${name}-${i}`}
                  ref={(n) => { itemRefs.current[i] = n; }}
                  type="button" role="menuitem" tabIndex={i === activeIndex ? 0 : -1}
                  data-emoji={name} aria-label={label(name)}
                  onFocus={() => setActiveIndex(i)}
                  onPointerDown={(e) => startHold(name, e.currentTarget.getBoundingClientRect())}
                  onPointerUp={stopHold} onPointerLeave={stopHold} onPointerCancel={stopHold}
                  onClick={(e) => onEmojiClick(name, e.currentTarget)}
                  className="relative z-10 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                  initial={reduced ? false : { scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ type: 'spring', stiffness: 800, damping: 25, delay: reduced ? 0 : 0.04 + i * 0.035 }}
                  whileHover={reduced ? undefined : { scale: 1.28, y: -4 }}
                  whileTap={{ scale: 0.92 }}
                  style={{ fontSize: s.emoji }}
                >
                  {EMOJI_MAP[name] || name}
                </motion.button>
              ))}
            </div>
            <span className={cn('absolute size-3 -translate-x-1/2 rounded-full', SURFACE, top ? '-bottom-1' : '-top-1')} style={{ left: placement.tailX }} />
          </motion.div>
        )}
      </AnimatePresence>
      <Trigger
        ref={setTriggerRef}
        type={asChild ? undefined : 'button'}
        aria-haspopup="true" aria-expanded={open}
        aria-label={open ? 'Close reactions' : last ? `Reacted ${label(last)}` : 'Add a reaction'}
        onPointerDown={onTriggerPointerDown}
        onClick={() => {
          if (justOpened.current) { justOpened.current = false; return; }
          if (open) close(); else setOpen(true);
        }}
        className={asChild ? undefined : cn('relative z-10 grid place-items-center rounded-full text-white/60 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40', SURFACE, s.trigger)}
      >
        {asChild ? children : open ? <X className={s.icon} strokeWidth={2} /> : last ? <span style={{ fontSize: s.emoji * 0.72 }}>{EMOJI_MAP[last] || last}</span> : <SmileIcon className={s.icon} />}
      </Trigger>
    </div>
  );
}

export default EmojiReaction;
