import React, { useEffect, useState } from 'react';
import {
  Camera,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Pause,
  Play,
} from 'lucide-react';
import { GoogleSignInButton } from '../components/GoogleSignInButton';
import { useAuth } from '../context/AuthContext';

const IMPACT_SLIDES = [
  {
    label: 'The problem',
    title: 'Atlanta’s infrastructure is fighting the weather—and time.',
    stat: '35.9%',
    statLabel: 'of settled pothole cases reach a confirmed resolution',
    paragraphs: [
      'Every Atlanta native has run into potholes, whether on a city street or a neighborhood sidewalk. Heavy traffic, frequent rain, and aging underground pipes have made road hazards a defining part of daily life.',
      'Potholes are the single most-filed category on Atlanta’s 311 portal, yet city data shows only about 35.9% of settled pothole cases reach a confirmed resolution.',
      'Responsibility is split between ATL311, Fulton and DeKalb county public works, and GDOT for state routes—so finding who owns a block can take real research.',
    ],
    sources: 'Sources: Axios Atlanta · ConsumerAffairs · Atlanta 311 Analysis',
  },
  {
    label: 'The friction',
    title: 'There is no convenient way for everyday residents to act.',
    stat: '3+',
    statLabel: 'systems can be involved in one metro-area road report',
    paragraphs: [
      'Reporting a hazard means stopping your day, identifying the right government portal, and manually typing in street details.',
      'That fragmented process asks residents to understand city, county, and state boundaries before they can even report the problem. Most road damage goes undocumented until a tire blows out or a major repair is overdue.',
    ],
    sources: 'Sources: ATL311 · Atlanta Injury Lawyer Blog · 1-800-LION Law',
  },
  {
    label: 'The live layer',
    title: 'A photo becomes verified, real-time street data.',
    stat: '1 snap',
    statLabel: 'captures the location, date, and time',
    paragraphs: [
      'PatchUp turns passive frustration into reliable infrastructure data by making reporting effortless and fun. Patchers snap a photo, earn badges, and climb leaderboards while the platform extracts the exact location, date, and time.',
      'Every submission runs through an image classifier that verifies the photo actually shows a pothole before it reaches the map. The result is a live, ground-truth layer that static mapping tools miss—especially when local Street View imagery dates to March 2025.',
    ],
    sources: 'Method: image classification · photo metadata · coordinate verification',
  },
  {
    label: 'The handoff',
    title: 'Five reports turn scattered evidence into one clear signal.',
    stat: '5',
    statLabel: 'verified reports trigger automated routing',
    paragraphs: [
      'Once five verified reports land on a single street, PatchUp automatically drafts a consolidated report for the exact authority responsible for that road.',
      'Instead of forcing residents to navigate jurisdictional boundaries alone, the platform packages verified, timestamped evidence and routes it to the city, county, or state agency that can fix it.',
    ],
    sources: 'Routing targets: City of Atlanta · Fulton County · DeKalb County · GDOT',
  },
] as const;

export const LandingView: React.FC = () => {
  const { authError, isSigningIn, signIn } = useAuth();
  const [impactSlide, setImpactSlide] = useState(0);
  const [impactAutoplay, setImpactAutoplay] = useState(
    () => !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    if (!impactAutoplay) return;
    const timer = window.setTimeout(() => {
      setImpactSlide((current) => (current + 1) % IMPACT_SLIDES.length);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [impactAutoplay, impactSlide]);

  const selectImpactSlide = (index: number) => {
    setImpactSlide((index + IMPACT_SLIDES.length) % IMPACT_SLIDES.length);
  };

  return (
    <div className="landing-shell min-h-dvh">
      <header className="landing-header">
        <div className="landing-logo">
          <img src="/patchup-logo.png" alt="PatchUp" />
        </div>
        <div className="landing-header-note">ATLANTA’S COMMUNITY ROAD WATCH</div>
        <GoogleSignInButton
          onClick={() => void signIn()}
          disabled={isSigningIn}
          label="Sign in"
        />
      </header>

      <main className="editorial-home landing-main">
        <section className="cover-story">
          <div className="cover-copy">
            <div className="cover-kicker"><span>Atlanta, GA</span></div>
            <div>
              <p className="cover-eyebrow">Atlanta, your block is calling.</p>
              <h1>SEE IT.<br />SNAP IT.<br /><em>PATCH IT.</em></h1>
            </div>
            <p className="cover-deck">
              Turn Atlanta’s worst roads into a neighborhood scoreboard. Snap photos of the
              potholes you find, rack up badges against your friends, and once a street hits five
              reports, we'll put it straight on the city's radar.
            </p>

            <div className="cover-actions">
              <GoogleSignInButton
                onClick={() => void signIn()}
                disabled={isSigningIn}
                label="Join with Google"
              />
              <div className="landing-promise">
                <Camera className="w-4 h-4" />
                <span>One photo is all it takes</span>
              </div>
            </div>

            {authError && <p className="landing-auth-error">{authError}</p>}
          </div>

          <div className="cover-art">
            <img
              src="/patchup-atlanta-hero.png"
              alt="Illustrated Atlanta street scene with a skateboarder, MARTA bus, downtown skyline, and a pothole"
            />
            <div className="cover-disclaimer">
              Not affiliated with MARTA. This case study is not for commercial use.
            </div>
            <div className="cover-caption">
              <span>Field notes from the 404</span>
              <strong>PATCHERS WANTED</strong>
            </div>
          </div>
        </section>

        <div className="news-ticker" aria-label="How PatchUp works">
          <span>01 · SPOT THE DAMAGE</span>
          <span>02 · SNAP THE EVIDENCE</span>
          <span>03 · VERIFY THE BLOCK</span>
          <span>04 · MOVE THE CITY</span>
        </div>

        <section className={`mission-grid ${impactAutoplay ? 'is-playing' : ''}`}>
          <div className="mission-intro">
            <span className="section-index">THE IDEA / 001</span>
            <h2>A SMALL ACT<br />WITH <em>STREET-LEVEL</em><br />IMPACT.</h2>
            <div className="impact-rail" aria-label="Impact story progress">
              {IMPACT_SLIDES.map((slide, index) => (
                <button
                  key={slide.label}
                  type="button"
                  onClick={() => selectImpactSlide(index)}
                  className={impactSlide === index ? 'is-active' : ''}
                  aria-label={`Show ${slide.label}`}
                  aria-current={impactSlide === index ? 'step' : undefined}
                >
                  <span>0{index + 1}</span>
                  <span>{slide.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mission-copy">
            <article className="impact-story" key={impactSlide}>
              <div className="impact-story-meta">
                <span>0{impactSlide + 1} / 0{IMPACT_SLIDES.length}</span>
                <span>{IMPACT_SLIDES[impactSlide].label}</span>
              </div>
              <h3>{IMPACT_SLIDES[impactSlide].title}</h3>
              <div className="impact-stat">
                <strong>{IMPACT_SLIDES[impactSlide].stat}</strong>
                <span>{IMPACT_SLIDES[impactSlide].statLabel}</span>
              </div>
              <div className="impact-body">
                {IMPACT_SLIDES[impactSlide].paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              <p className="impact-sources">{IMPACT_SLIDES[impactSlide].sources}</p>
            </article>

            <div className="impact-controls">
              <div className="impact-arrows">
                <button type="button" onClick={() => selectImpactSlide(impactSlide - 1)} aria-label="Previous impact story">
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button type="button" onClick={() => selectImpactSlide(impactSlide + 1)} aria-label="Next impact story">
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
              <button
                type="button"
                className="impact-playback"
                onClick={() => setImpactAutoplay((playing) => !playing)}
                aria-label={impactAutoplay ? 'Pause impact slideshow' : 'Play impact slideshow'}
              >
                {impactAutoplay ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                <span>{impactAutoplay ? 'Auto-playing' : 'Paused'}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="landing-final-cta">
          <div>
            <span>YOUR BLOCK NEEDS A PATCHER</span>
            <h2>READY TO PUT<br />YOUR STREET<br />ON THE MAP?</h2>
          </div>
          <div>
            <p>Join your neighbors, document what the city misses, and make every snap count.</p>
            <GoogleSignInButton
              onClick={() => void signIn()}
              disabled={isSigningIn}
              label="Join with Google"
            />
            <span className="landing-signin-note">Free to join · Google account required</span>
          </div>
          <MapPin className="landing-cta-pin" aria-hidden="true" />
        </section>
      </main>

      <footer className="landing-footer">
        <span>PATCHUP · ATLANTA, GEORGIA</span>
        <span>Independent community project · Not affiliated with the City of Atlanta or MARTA</span>
      </footer>
    </div>
  );
};
