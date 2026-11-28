// Vendored GSAP bundle for the landing hero (served from /vendor/gsap.js so CSP script-src 'self' stays clean).
import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { DrawSVGPlugin } from 'gsap/DrawSVGPlugin';

gsap.registerPlugin(MotionPathPlugin, DrawSVGPlugin);

export { gsap };
