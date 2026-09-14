import { useEffect, useId, useRef } from 'react'

import { subscribeRider, type RiderMode } from './riderTicker'

type RiderParts = {
  rear: React.RefObject<SVGGElement>
  front: React.RefObject<SVGGElement>
  pelican: React.RefObject<SVGGElement>
  head: React.RefObject<SVGGElement>
  eye: React.RefObject<SVGGElement>
  shadow: React.RefObject<SVGEllipseElement>
  nearLeg: React.RefObject<SVGPathElement>
  nearFoot: React.RefObject<SVGPathElement>
  nearCrank: React.RefObject<SVGPathElement>
  nearPedal: React.RefObject<SVGPathElement>
  farLeg: React.RefObject<SVGPathElement>
  farFoot: React.RefObject<SVGPathElement>
  farCrank: React.RefObject<SVGPathElement>
  farPedal: React.RefObject<SVGPathElement>
  scarf: React.RefObject<SVGPathElement>
  scarfBack: React.RefObject<SVGPathElement>
  paddleA: React.RefObject<SVGGElement>
  paddleB: React.RefObject<SVGGElement>
  splash: React.RefObject<SVGGElement>
  ripples: [React.RefObject<SVGPathElement>, React.RefObject<SVGPathElement>, React.RefObject<SVGPathElement>]
}

type RiderCtx = {
  mode: RiderMode
  prevMode: RiderMode | null
  phase: number
  lastTime: number | null
  shakeUntil: number
  action: { type: 'dip' | 'look'; start: number } | null
  nextActionAt: number
}

const BASE_CADENCE = 4.4
const SWIM_CADENCE = 1.6
const ACTION_DURATION = 1.8
const PELICAN_BODY = 'M600 386Q617 349 666 351Q704 353 728 340Q748 327 754 289Q758 249 787 239Q817 228 835 249Q852 275 834 304Q815 329 809 362Q805 389 779 422Q754 459 707 472Q651 484 614 452Q590 431 600 386Z'

// Two-bone inverse kinematics keeps both webbed feet attached to the pedals.
function poseLeg(parts: RiderParts, side: 'near' | 'far', phase: number, bob: number) {
  const hipX = side === 'near' ? 688 : 666
  const hipY = 454 + bob
  const footX = 700 + Math.cos(phase) * 37
  const footY = 625 + Math.sin(phase) * 37
  const dx = footX - hipX
  const dy = footY - hipY
  const upper = 105
  const lower = 112
  const distance = Math.min(Math.hypot(dx, dy), upper + lower - 0.01)
  const base = Math.atan2(dy, dx)
  const bend = Math.acos(Math.max(-1, Math.min(1, (upper * upper + distance * distance - lower * lower) / (2 * upper * distance))))
  const kneeX = hipX + Math.cos(base - bend) * upper
  const kneeY = hipY + Math.sin(base - bend) * upper

  const leg = parts[`${side}Leg`].current
  if (leg) leg.setAttribute('d', `M${hipX} ${hipY}Q${hipX + 4} ${hipY + 22} ${kneeX.toFixed(1)} ${kneeY.toFixed(1)}L${footX.toFixed(1)} ${(footY - 5).toFixed(1)}`)
  const foot = parts[`${side}Foot`].current
  if (foot) foot.setAttribute('d', `M${footX - 6} ${footY - 9}Q${footX + 3} ${footY - 7} ${footX + 10} ${footY - 3}L${footX + 23} ${footY + 3}Q${footX + 25} ${footY + 6} ${footX + 18} ${footY + 6}H${footX - 12}Q${footX - 17} ${footY + 4} ${footX - 12} ${footY - 1}Z`)
  const crank = parts[`${side}Crank`].current
  if (crank) crank.setAttribute('d', `M700 625L${footX.toFixed(1)} ${(footY + 5).toFixed(1)}`)
  const pedal = parts[`${side}Pedal`].current
  if (pedal) pedal.setAttribute('d', `M${footX - 14} ${footY + 9}H${footX + 17}`)
}

function setScarf(parts: RiderParts, time: number, damp: number) {
  const flutter = Math.sin(time * 8) * 7 * damp
  const tip = Math.sin(time * 8 - 1.2) * 9 * damp
  if (parts.scarf.current) {
    parts.scarf.current.setAttribute('d', `M765 342Q716 ${358 + flutter} 683 ${340 + flutter}Q651 ${323 + tip} 618 ${337 + tip}L632 ${347 + tip}L621 ${358 + tip}Q657 ${344 + tip} 686 ${357 + flutter}Q727 ${375 + flutter} 770 353Z`)
  }
  if (parts.scarfBack.current) {
    parts.scarfBack.current.setAttribute('d', `M763 343Q723 ${336 - flutter} 699 ${318 - flutter}Q674 ${310 - tip} 651 ${319 - tip}L663 ${329 - tip}L651 ${338 - tip}Q704 ${331 - flutter} 754 356Z`)
  }
}

function setBlink(parts: RiderParts, time: number) {
  const blinkTime = time % 5.1
  const eyeScale = blinkTime > 4.86 ? Math.max(0.08, Math.abs(blinkTime - 4.98) / 0.12) : 1
  if (parts.eye.current) parts.eye.current.setAttribute('transform', `translate(815 276) scale(1 ${eyeScale.toFixed(2)})`)
}

function drawRiding(parts: RiderParts, ctx: RiderCtx, time: number) {
  const bob = Math.sin(ctx.phase * 2) * 2.5
  const wheelAngle = (ctx.phase * 180 / Math.PI * 0.873) % 360
  const spin = `rotate(${wheelAngle.toFixed(1)})`
  if (parts.rear.current) parts.rear.current.setAttribute('transform', spin)
  if (parts.front.current) parts.front.current.setAttribute('transform', spin)
  if (parts.shadow.current) parts.shadow.current.setAttribute('rx', (276 - bob * 1.1).toFixed(1))
  poseLeg(parts, 'far', ctx.phase + Math.PI, bob)
  poseLeg(parts, 'near', ctx.phase, bob)

  let lean = 0
  if (ctx.shakeUntil > time && time > ctx.shakeUntil - 0.5) lean = Math.sin(time * 45) * 6
  if (parts.pelican.current) {
    parts.pelican.current.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${lean.toFixed(1)} 700 450)`)
  }
  if (parts.head.current) parts.head.current.setAttribute('transform', '')
  if (parts.splash.current) parts.splash.current.setAttribute('opacity', '0')
  setScarf(parts, time, 1)
}

function drawSwimming(parts: RiderParts, ctx: RiderCtx, time: number) {
  const bob = Math.sin(ctx.phase) * 3.5
  let pitch = Math.sin(ctx.phase * 0.5 + 1) * 1.2
  let headAngle = 0
  let splashOpacity = 0

  if (!ctx.action && time > ctx.nextActionAt) {
    ctx.action = { type: Math.random() < 0.5 ? 'dip' : 'look', start: time }
  }
  if (ctx.action) {
    const p = (time - ctx.action.start) / ACTION_DURATION
    if (p >= 1) {
      ctx.action = null
      ctx.nextActionAt = time + 8 + Math.random() * 4
    } else if (ctx.action.type === 'dip') {
      // Lunge with the whole body and only tip the head a little, so the
      // neck stays connected while the beak reaches the waterline.
      pitch += 15 * Math.sin(p * Math.PI)
      headAngle = 8 * Math.sin(p * Math.PI)
      if (p > 0.3 && p < 0.7) splashOpacity = Math.sin(((p - 0.3) / 0.4) * Math.PI)
    } else {
      headAngle = -8 * Math.sin(p * Math.PI)
    }
  }

  if (parts.pelican.current) {
    parts.pelican.current.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${pitch.toFixed(2)} 715 500)`)
  }
  if (parts.head.current) {
    parts.head.current.setAttribute('transform', headAngle ? `rotate(${headAngle.toFixed(1)} 760 340)` : '')
  }
  if (parts.splash.current) parts.splash.current.setAttribute('opacity', splashOpacity.toFixed(2))

  if (parts.paddleA.current) parts.paddleA.current.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${(22 * Math.sin(ctx.phase)).toFixed(1)} 0 -10)`)
  if (parts.paddleB.current) parts.paddleB.current.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${(22 * Math.sin(ctx.phase + Math.PI)).toFixed(1)} 0 -10)`)

  parts.ripples.forEach((ripple, index) => {
    const p = (time * 0.35 + index / 3) % 1
    const el = ripple.current
    if (el) {
      el.setAttribute('transform', `translate(${(p * 14).toFixed(1)} 0)`)
      el.setAttribute('opacity', (0.7 * (1 - p)).toFixed(2))
    }
  })
  setScarf(parts, time, 0.5)
}

export function PelicanRider({ speed, seed, mode }: { speed: number; seed: number; mode: RiderMode }) {
  const submergedClip = `pr-sub-${useId().replace(/:/g, '')}`
  const parts: RiderParts = {
    rear: useRef<SVGGElement>(null!),
    front: useRef<SVGGElement>(null!),
    pelican: useRef<SVGGElement>(null!),
    head: useRef<SVGGElement>(null!),
    eye: useRef<SVGGElement>(null!),
    shadow: useRef<SVGEllipseElement>(null!),
    nearLeg: useRef<SVGPathElement>(null!),
    nearFoot: useRef<SVGPathElement>(null!),
    nearCrank: useRef<SVGPathElement>(null!),
    nearPedal: useRef<SVGPathElement>(null!),
    farLeg: useRef<SVGPathElement>(null!),
    farFoot: useRef<SVGPathElement>(null!),
    farCrank: useRef<SVGPathElement>(null!),
    farPedal: useRef<SVGPathElement>(null!),
    scarf: useRef<SVGPathElement>(null!),
    scarfBack: useRef<SVGPathElement>(null!),
    paddleA: useRef<SVGGElement>(null!),
    paddleB: useRef<SVGGElement>(null!),
    splash: useRef<SVGGElement>(null!),
    ripples: [useRef<SVGPathElement>(null!), useRef<SVGPathElement>(null!), useRef<SVGPathElement>(null!)],
  }
  const ctx = useRef<RiderCtx>({
    mode,
    prevMode: null,
    phase: seed * 1.31,
    lastTime: null,
    shakeUntil: 0,
    action: null,
    nextActionAt: 4 + (seed % 5),
  })
  ctx.current.mode = mode

  useEffect(() => subscribeRider((time) => {
    const state = ctx.current
    const dt = state.lastTime === null ? 0 : Math.max(0, Math.min(time - state.lastTime, 0.05))
    state.lastTime = time
    if (state.prevMode !== state.mode) {
      if (state.mode === 'riding' && state.prevMode === 'swimming') state.shakeUntil = time + 1.8
      if (state.mode === 'swimming') {
        state.action = null
        state.nextActionAt = time + 5 + Math.random() * 4
      }
      state.prevMode = state.mode
    }
    state.phase += dt * (state.mode === 'swimming' ? SWIM_CADENCE : speed * BASE_CADENCE)
    if (state.mode === 'swimming') drawSwimming(parts, state, time)
    else drawRiding(parts, state, time)
    setBlink(parts, time)
  }), [speed, mode])

  return (
    <svg className="pelican-rider" viewBox="410 200 620 534" aria-hidden="true">
      <ellipse ref={parts.shadow} className="pr-shadow" cx="719" cy="736" rx="276" ry="13" />

      <g className="pr-bike">
        <g transform="translate(535 625)">
          <g ref={parts.rear}>
            <WheelArt />
          </g>
        </g>
        <g transform="translate(900 625)">
          <g ref={parts.front}>
            <WheelArt />
          </g>
        </g>

        <path d="M432 595A108 108 0 0 1 617 555M817 554A108 108 0 0 1 1003 594" fill="none" stroke="#e37a66" strokeWidth="7" />
        <path d="M451 581L535 625M986 581L900 625" fill="none" stroke="#557b6c" strokeWidth="2" />

        <path ref={parts.farLeg} d="M666 455L746 528L665 625" fill="none" stroke="#cf9147" strokeWidth="12" />
        <path ref={parts.farFoot} fill="#df9f4a" stroke="#c98a3e" strokeWidth="1.5" />
        <path ref={parts.farCrank} d="M700 625H665" fill="none" stroke="#668575" strokeWidth="7" />
        <path ref={parts.farPedal} d="M650 633H680" stroke="#244740" strokeWidth="7" />

        <g fill="none">
          <path d="M535 625L640 500L700 625ZM640 500L849 480L700 625" stroke="#ad5146" strokeWidth="13" />
          <path d="M535 625L640 500L700 625ZM640 500L849 480L700 625" stroke="#e57862" strokeWidth="9" />
          <path d="M646 510L829 493" stroke="#f6ad90" strokeWidth="2.5" />
          <path d="M847 458L856 497L900 625" stroke="#e57862" strokeWidth="10" />
          <path d="M847 458L838 433Q834 418 850 416H884" stroke="#446c60" strokeWidth="7" />
          <path d="M870 416H890" stroke="#244740" strokeWidth="10" />
          <path d="M857 427Q912 454 876 529" stroke="#446c60" strokeWidth="2" />
          <path d="M640 500L631 477" stroke="#446c60" strokeWidth="7" />
          <path d="M535 613L698 600A25 25 0 1 1 698 650L535 638A12 12 0 0 1 535 613Z" stroke="#476e60" strokeWidth="2.5" />
        </g>
        <path d="M604 472Q628 466 646 473L668 474Q675 476 669 482Q639 490 606 482Q599 480 604 472Z" fill="#244740" />
        <circle cx="700" cy="625" r="27" fill="#e4e8d8" stroke="#476e60" strokeWidth="3" />
        <circle cx="700" cy="625" r="19" fill="none" stroke="#96aa92" strokeWidth="2" strokeDasharray="2 7" />
        <path d="M742 512L771 509" stroke="#fcdbb5" strokeWidth="5" />
        <circle cx="861" cy="405" r="7" fill="#f4cd6d" stroke="#446c60" strokeWidth="2" />

        <path ref={parts.nearCrank} d="M700 625H737" fill="none" stroke="#476e60" strokeWidth="8" />
        <path ref={parts.nearLeg} d="M687 458L780 522L737 625" fill="none" stroke="#efb052" strokeWidth="14" />
        <path ref={parts.nearFoot} fill="#f4b54f" stroke="#d39a44" strokeWidth="1.5" />
        <path ref={parts.nearPedal} d="M722 633H752" stroke="#244740" strokeWidth="7" />
        <circle cx="700" cy="625" r="7" fill="#244740" />
      </g>

      <g ref={parts.pelican}>
        <g className="pr-pelican-lift">
          <path d="M620 391Q582 367 559 378L580 403L548 397Q565 426 602 431Z" fill="#e4e9db" stroke="#638477" strokeWidth="2" />
          <path d={PELICAN_BODY} fill="#fcfcf2" stroke="#638477" strokeWidth="2.5" />
          <path d="M611 433Q649 464 705 453Q755 445 779 413Q757 457 707 471Q650 484 614 452Z" fill="#e5eadc" />
          <path d="M751 298Q753 268 770 254" fill="none" stroke="#e3e9dc" strokeWidth="10" />
          <path className="pr-wing-folded" d="M700 372Q668 378 650 398Q634 420 624 446L638 444Q660 428 676 408Q692 388 700 372Z" />
          <path className="pr-wing-folded-line" d="M688 380Q662 398 644 430" />
          <g ref={parts.head}>
            <path d="M764 249Q750 229 752 219Q766 223 778 241M773 240Q770 218 779 214Q788 224 788 237" fill="#fcfcf2" stroke="#638477" strokeWidth="2" />
            <path d="M826 278Q895 287 1008 323Q968 365 913 371Q857 368 827 315Z" fill="#f1c35f" stroke="#a58447" strokeWidth="2" />
            <path d="M833 303Q867 350 925 354Q971 350 1008 323Q968 365 913 371Q857 368 827 315Z" fill="#e8b352" />
            <path d="M825 273Q899 276 1016 323Q1024 327 1013 332Q907 317 825 306Z" fill="#f4a84b" stroke="#a58447" strokeWidth="2" />
            <path d="M838 282Q918 292 993 319" fill="none" stroke="#ffd784" strokeWidth="4" />
            <path d="M826 306Q916 317 1013 332" fill="none" stroke="#b68e48" strokeWidth="2" />
            <ellipse cx="816" cy="277" rx="13" ry="15" fill="#f7df9c" />
            <g ref={parts.eye} transform="translate(815 276)">
              <ellipse rx="5.5" ry="7" fill="#244740" />
              <circle cx="1.6" cy="-2.4" r="1.8" fill="white" />
            </g>
            <path d="M803 256Q810 251 817 254" fill="none" stroke="#638477" strokeWidth="2.5" />
          </g>
          <path ref={parts.scarfBack} className="pr-scarf-back" d="M763 343Q723 336 699 318Q674 310 651 319L663 329L651 338Q704 331 754 356Z" />
          <path ref={parts.scarf} className="pr-scarf" d="M765 342Q716 358 683 340Q651 323 618 337L632 347L621 358Q657 344 686 357Q727 375 770 353Z" />
          <path className="pr-scarf-band" d="M754 330Q773 344 803 343L799 358Q772 360 750 346Z" />
          <path className="pr-scarf-hi" d="M759 336Q776 347 795 347" fill="none" strokeWidth="3" />
          <path className="pr-scarf-knot" d="M759 343Q746 343 748 352Q751 364 765 357Q774 349 759 343Z" />
          <path className="pr-wing" d="M660 371Q687 360 714 384Q758 414 806 417L853 412Q864 411 865 419Q865 428 851 433L803 440Q745 448 691 425Q668 415 660 394" fill="#e8eddf" stroke="#638477" strokeWidth="2" />
          <path d="M681 391Q721 426 794 430M680 404Q721 438 774 438" fill="none" stroke="#c4d3c2" strokeWidth="2" />
          <path d="M836 417L852 416M836 423L854 422" fill="none" stroke="#a2b7a3" strokeWidth="1.5" />
          <g className="pr-submerged" clipPath={`url(#${submergedClip})`}>
            <path d={PELICAN_BODY} />
          </g>
        </g>
      </g>

      <defs>
        <clipPath id={submergedClip}>
          <rect x="380" y="452" width="650" height="282" />
        </clipPath>
      </defs>

      <g className="pr-water">
        <g transform="translate(688 641)">
          <g ref={parts.paddleA} className="pr-paddle">
            <path className="pr-paddle-ankle" d="M-2 -11Q-1 -6 -2 -1" />
            <path d="M-4 -1Q7 0 13 6Q17 10 11.5 11.5Q3 13.5 -7 9.5Q-11 4 -4 -1Z" />
          </g>
        </g>
        <g transform="translate(724 644)">
          <g ref={parts.paddleB} className="pr-paddle">
            <path className="pr-paddle-ankle" d="M-2 -11Q-1 -6 -2 -1" />
            <path d="M-4 -1Q7 0 13 6Q17 10 11.5 11.5Q3 13.5 -7 9.5Q-11 4 -4 -1Z" />
          </g>
        </g>
        <path className="pr-waterline" d="M404 622Q560 626 640 624Q700 634 760 634Q820 634 880 624Q950 622 1026 622" />
        <path ref={parts.ripples[0]} className="pr-ripple" d="M852 636Q890 626 928 634" />
        <path ref={parts.ripples[1]} className="pr-ripple" d="M872 646Q906 637 940 644" />
        <path ref={parts.ripples[2]} className="pr-ripple" d="M892 656Q922 648 952 654" />
        <g ref={parts.splash} className="pr-splash" opacity="0">
          <circle cx="988" cy="606" r="4" />
          <circle cx="1002" cy="596" r="3" />
          <circle cx="1014" cy="607" r="2.5" />
        </g>
      </g>
    </svg>
  )
}

function WheelArt() {
  return (
    <>
      <circle r="103" fill="#f9fbf5" fillOpacity=".22" stroke="#244740" strokeWidth="12" />
      <circle r="94" fill="none" stroke="#fafaf0" strokeWidth="4" />
      <g stroke="#577c70" strokeWidth="1.65" opacity=".72">
        <path d="M0-91V91M-91 0H91M-64.35-64.35L64.35 64.35M-64.35 64.35L64.35-64.35M-34.82-84.07L34.82 84.07M-84.07-34.82L84.07 34.82M-84.07 34.82L84.07-34.82M-34.82 84.07L34.82-84.07" />
      </g>
      <circle r="12" fill="#244740" />
      <circle r="5" fill="#e5dfc7" />
      <path d="M-38-85L-27-89" stroke="#fffdf4" strokeWidth="4" strokeLinecap="round" />
    </>
  )
}
