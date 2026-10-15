/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  words,
  sentences,
  unit8GrammarPatterns,
  schoolPhonetics,
  qaLessons,
  rearrangeLessons,
  quizQuestions,
  blanks,
  fillVocabulary,
  WordEntry,
  SentenceEntry
} from './data.ts';

// Helper for safe localStorage access
function safeGet(key: string, fallback: string = ''): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors in private/sandboxed mode
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

function safeDone(): string[] {
  try {
    const d = JSON.parse(safeGet('thaiDoneUnit8V4', '[]'));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}

// Convert Thai/Arabic numerals to complete Thai number words BEFORE speech synthesis.
function thaiNumberWords(value: string | number): string {
  const digits = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const places = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];

  function underMillion(n: number): string {
    if (n === 0) return digits[0];
    let spoken = '';
    for (let place = 5; place >= 0; place--) {
      const digit = Math.floor(n / 10 ** place) % 10;
      if (!digit) continue;
      if (place === 1) {
        spoken += digit === 1 ? 'สิบ' : digit === 2 ? 'ยี่สิบ' : digits[digit] + 'สิบ';
      } else if (place === 0) {
        spoken += digit === 1 && n >= 10 ? 'เอ็ด' : digits[digit];
      } else {
        spoken += digits[digit] + places[place];
      }
    }
    return spoken;
  }

  const s = String(value)
    .replace(/[๐-๙]/g, ch => String(ch.charCodeAt(0) - '๐'.charCodeAt(0)))
    .replace(/,/g, '');

  if (!/^\d+$/.test(s) || s.length > 12) return String(value);
  const n = Number(s);
  if (n < 1000000) return underMillion(n);
  const millions = Math.floor(n / 1000000);
  const rest = n % 1000000;
  return thaiNumberWords(String(millions)) + 'ล้าน' + (rest ? underMillion(rest) : '');
}

function prepareThaiSpeechText(text: string): string {
  return text
    .replace(/[0-9๐-๙][0-9๐-๙,]*/g, n => thaiNumberWords(n))
    .replace(/วันที่\s+(?=[ก-๙])/g, 'วันที่');
}

export default function App() {
  const [page, setPage] = useState<'home' | 'learn' | 'practice' | 'flash' | 'settings'>('home');
  const [learnTab, setLearnTab] = useState<'Words' | 'Sentences' | 'Q & A' | 'Grammar'>('Words');
  const [learnIndex, setLearnIndex] = useState(0);
  const [qaIndex, setQaIndex] = useState(0);
  const [flashIndex, setFlashIndex] = useState(0);
  const [flashBack, setFlashBack] = useState(false);
  const [practice, setPractice] = useState<'quiz' | 'blank' | 'rearrange'>('quiz');
  
  // Practice states
  const [quizIndex, setQuizIndex] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [quizResponses, setQuizResponses] = useState<{ index: number; choice: number; correct: boolean }[]>([]);

  const [fillIndex, setFillIndex] = useState(0);
  const [fillChoice, setFillChoice] = useState<number | null>(null);
  const [fillChecked, setFillChecked] = useState(false);

  const [reorderIndex, setReorderIndex] = useState(0);
  const [reorderPicked, setReorderPicked] = useState<number[]>([]);
  const [reorderChecked, setReorderChecked] = useState(false);

  // Settings & audio
  const [speed, setSpeed] = useState<number>(() => {
    const s = parseFloat(safeGet('thaiSpeed', '0.85'));
    return isNaN(s) ? 0.85 : s;
  });
  const [done, setDone] = useState<string[]>(safeDone);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [detectedVoices, setDetectedVoices] = useState<string>('');

  // Audio recording
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [audioURLs, setAudioURLs] = useState<Record<string, string>>({});
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Calculate overall progress percentage
  const totalActivities = useMemo(() => {
    return words.length + sentences.length + qaLessons.length + rearrangeLessons.length + quizQuestions.length + blanks.length;
  }, []);

  const progressPct = useMemo(() => {
    return Math.min(100, Math.round((done.length / Math.max(1, totalActivities)) * 100));
  }, [done.length, totalActivities]);

  const markDone = (key: string) => {
    setDone(prev => {
      if (!prev.includes(key)) {
        const next = [...prev, key];
        safeSet('thaiDoneUnit8V4', JSON.stringify(next));
        return next;
      }
      return prev;
    });
  };

  // Update voices on mount
  useEffect(() => {
    const updateVoices = () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const vs = window.speechSynthesis.getVoices() || [];
        const thVoices = vs.filter(v => v.lang.toLowerCase().startsWith('th'));
        if (thVoices.length > 0) {
          setDetectedVoices(thVoices.map(x => `${x.name} (${x.lang})`).join(', '));
        } else {
          setDetectedVoices('No Thai voice is currently detected on this device.');
        }
      }
    };
    updateVoices();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = updateVoices;
    }
  }, []);

  // Text-to-speech
  const speak = (rawText: string, speedOverride?: number) => {
    if (!('speechSynthesis' in window)) {
      alert('ဤဖုန်းတွင် စာသားမှ အသံဖတ်သည့်စနစ် မရရှိပါ။');
      return;
    }
    const text = prepareThaiSpeechText(rawText);
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'th-TH';
    u.rate = speedOverride || speed;
    const voices = window.speechSynthesis.getVoices();
    const v = voices.find(x => x.lang.toLowerCase() === 'th-th') || voices.find(x => x.lang.toLowerCase().startsWith('th'));
    if (v) {
      u.voice = v;
    } else {
      setStatusMessage('Thai voice not found. Your phone may use a fallback voice. For accurate Thai tones, use recorded audio in the production app.');
    }
    window.speechSynthesis.speak(u);
  };

  // Microphone recording
  const toggleRecord = async (id: string) => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.stop();
      setRecordingId(null);
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      alert('Recording requires microphone permissions and a compatible browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      setRecordingId(id);

      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      rec.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const newUrl = URL.createObjectURL(blob);
        setAudioURLs(prev => {
          if (prev[id]) {
            URL.revokeObjectURL(prev[id]);
          }
          return { ...prev, [id]: newUrl };
        });
      };

      recorderRef.current = rec;
      rec.start();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert('Microphone permission unavailable: ' + msg);
      setRecordingId(null);
    }
  };

  const navigateTo = (p: 'home' | 'learn' | 'practice' | 'flash' | 'settings') => {
    setPage(p);
    window.scrollTo(0, 0);
  };

  // Learn tab stepping
  const stepLearn = (direction: number) => {
    const list = learnTab === 'Words' ? words : sentences;
    markDone(`learn-${learnTab}-${learnIndex}`);
    setLearnIndex((learnIndex + direction + list.length) % list.length);
  };

  const stepQA = (direction: number) => {
    markDone(`learn-qa-${qaIndex}`);
    setQaIndex((qaIndex + direction + qaLessons.length) % qaLessons.length);
  };

  // Flashcards
  const flipCard = () => {
    setFlashBack(!flashBack);
    markDone(`card-${flashIndex}`);
  };

  const stepFlash = (direction: number) => {
    setFlashIndex((flashIndex + direction + words.length) % words.length);
    setFlashBack(false);
  };

  // Quiz logic
  const handleQuizChoice = (choiceIndex: number) => {
    const q = quizQuestions[quizIndex];
    if (quizResponses.some(r => r.index === quizIndex)) return;
    const isCorrect = choiceIndex === q.correct;
    setQuizResponses(prev => [...prev, { index: quizIndex, choice: choiceIndex, correct: isCorrect }]);
    if (isCorrect) {
      setQuizScore(prev => prev + 1);
    }
  };

  const nextQuizQuestion = () => {
    if (quizIndex + 1 >= quizQuestions.length) {
      markDone('unit8-quiz-completed');
    }
    setQuizIndex(prev => prev + 1);
  };

  const restartQuiz = () => {
    setQuizIndex(0);
    setQuizScore(0);
    setQuizResponses([]);
  };

  // Listen and Fill logic
  const handleFillChoice = (choiceIndex: number) => {
    if (fillChecked) return;
    setFillChoice(choiceIndex);
  };

  const checkFill = () => {
    if (fillChecked || fillChoice === null) return;
    const q = blanks[fillIndex % blanks.length];
    setFillChecked(true);
    if (q.choices[fillChoice] === q.answer) {
      markDone(`blank-${fillIndex}`);
    }
  };

  const retryFill = () => {
    setFillChoice(null);
    setFillChecked(false);
  };

  const completeFillExercise = () => {
    const q = blanks[fillIndex % blanks.length];
    if (fillChecked && fillChoice !== null && q.choices[fillChoice] === q.answer) {
      markDone(`blank-${fillIndex}`);
    }
    setFillIndex(prev => (prev + 1) % blanks.length);
    setFillChoice(null);
    setFillChecked(false);
  };

  // Rearrange sentence logic
  const currentRearrange = rearrangeLessons[reorderIndex];
  const rearrangeBankOrder = useMemo(() => {
    const n = currentRearrange.parts.length;
    return Array.from({ length: n }, (_, i) => n - 1 - i);
  }, [currentRearrange]);

  const availableTokens = useMemo(() => {
    return rearrangeBankOrder.filter(id => !reorderPicked.includes(id));
  }, [rearrangeBankOrder, reorderPicked]);

  const isRearrangeComplete = reorderPicked.length === currentRearrange.parts.length;
  const isRearrangeCorrect = reorderChecked && isRearrangeComplete && reorderPicked.every((id, j) => id === j);

  const pickRearranged = (id: number) => {
    if (reorderPicked.includes(id) || reorderPicked.length >= currentRearrange.parts.length) return;
    setReorderPicked(prev => [...prev, id]);
    setReorderChecked(false);
  };

  const removeRearranged = (id: number) => {
    setReorderPicked(prev => prev.filter(x => x !== id));
    setReorderChecked(false);
  };

  const checkRearranged = () => {
    if (reorderPicked.length !== currentRearrange.parts.length) return;
    setReorderChecked(true);
    if (reorderPicked.every((id, j) => id === j)) {
      markDone(`rearrange-${reorderIndex}`);
    }
  };

  const resetRearranged = () => {
    setReorderPicked([]);
    setReorderChecked(false);
  };

  const nextRearranged = () => {
    setReorderIndex((reorderIndex + 1) % rearrangeLessons.length);
    setReorderPicked([]);
    setReorderChecked(false);
  };

  // Render entry box with audio and record buttons
  const renderActions = (thai: string, withRecord: boolean = true, recId: string = 'main') => {
    const isRec = recordingId === recId;
    return (
      <>
        <div className="controls">
          <button type="button" className="btn" onClick={() => speak(thai)}>
            🔊 နားထောင်ပါ
          </button>
          <button type="button" className="btn secondary" onClick={() => speak(thai, 0.7)}>
            🐢 ဖြည်းဖြည်း
          </button>
          {withRecord && (
            <button
              type="button"
              className={`btn ghost ${isRec ? 'recording' : ''}`}
              onClick={() => toggleRecord(recId)}
            >
              {isRec ? '⏹️ Stop recording' : '🎙️ အသံသွင်းပါ'}
            </button>
          )}
        </div>
        {withRecord && audioURLs[recId] && (
          <div style={{ marginTop: '12px' }}>
            <p className="muted" style={{ margin: '4px 0' }}>သင့်အသံကို ပြန်နားထောင်ပါ</p>
            <audio controls src={audioURLs[recId]} />
          </div>
        )}
      </>
    );
  };

  const renderCardBox = (entry: WordEntry | SentenceEntry, label: string, withRecord: boolean = true, recId: string = 'main') => (
    <div className="card">
      <span className="tag">{label}</span>
      <div className="thai" lang="th">{entry[0]}</div>
      <div className="phonetic">{entry[1]}</div>
      <div className="mm" lang="my">{entry[2]}</div>
      {renderActions(entry[0], withRecord, recId)}
    </div>
  );

  return (
    <div className="app">
      {/* Hero Header */}
      <header className="hero">
        <div className="top">
          <div className="brandwrap">
            <img
              className="school-logo"
              src="https://lh3.googleusercontent.com/pw/AP1GczOgaajYlB0tna2h3tHcz5qkUYVKilPtE-iG2iI9HhTjmgxOtQoBcU3Q0L6qnm8euJIuRd81RCA6-1ya5D7I0ze4zn8xOKDgBqbf75rqMXMWANWcQrE=w2400"
              alt="ThaiSar school logo"
              onError={(e) => {
                // Fallback to SVG if needed
                (e.currentTarget as HTMLImageElement).src = '/school-logo.svg';
              }}
            />
            <div>
              <div className="brand-title">THAISAR</div>
              <div className="logo-label">Thai · Myanmar Speaking School</div>
            </div>
          </div>
          <div className="pill">🇹🇭 + 🇲🇲</div>
        </div>
        <h1>အခန်း (၈) · လမ်းညွှန်ခြင်း</h1>
        <p>Unit 8 · Listening & Speaking · Beginner</p>
        <div className="progress">
          <span style={{ width: `${progressPct}%` }}></span>
        </div>
        <div className="small" style={{ marginTop: '7px', color: '#e2f9f0' }}>
          သင်ယူမှု တိုးတက်မှု · {progressPct}% ({done.length} activities)
        </div>
      </header>

      {/* Main Content Area */}
      <main className="content">
        {/* HOME PAGE */}
        {page === 'home' && (
          <div>
            <div className="section-head">
              <h2>စတင်လေ့လာပါ 🌼</h2>
              <span className="muted">အခန်း ၈</span>
            </div>
            <div className="notice">
              အသံကို နားထောင်ပါ → လိုက်ပြောပါ → စာကြောင်းကို လေ့ကျင့်ပါ။ ထိုင်းအက္ခရာ အရင်ကျက်ရန် မလိုပါ။
            </div>
            <div className="rows" style={{ marginTop: '14px' }}>
              <button
                type="button"
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  setLearnTab('Words');
                  setLearnIndex(0);
                }}
              >
                <span className="emoji">📖</span>
                <strong>စကားလုံးများ</strong>
                <small>Vocabulary · {words.length} items</small>
              </button>

              <button
                type="button"
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  setLearnTab('Sentences');
                  setLearnIndex(0);
                }}
              >
                <span className="emoji">🎧</span>
                <strong>ဝါကျများ</strong>
                <small>Listen & repeat · {sentences.length}</small>
              </button>

              <button
                type="button"
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  setLearnTab('Grammar');
                }}
              >
                <span className="emoji">🧩</span>
                <strong>သဒ္ဒါ</strong>
                <small>Tap to see examples</small>
              </button>

              <button
                type="button"
                className="tile"
                onClick={() => {
                  navigateTo('learn');
                  setLearnTab('Q & A');
                  setQaIndex(0);
                }}
              >
                <span className="emoji">💬</span>
                <strong>အမေး / အဖြေ</strong>
                <small>10 learn-only dialogue pairs</small>
              </button>

              <button
                type="button"
                className="tile"
                onClick={() => {
                  navigateTo('practice');
                  setPractice('quiz');
                  restartQuiz();
                }}
              >
                <span className="emoji">📝</span>
                <strong>Unit 8 Quiz</strong>
                <small>12 comprehension questions</small>
              </button>
            </div>

            <h3 style={{ marginTop: '24px' }}>ဒီနေ့ လေ့လာမယ့် ဝါကျ</h3>
            {renderCardBox(sentences[0], 'Listen & repeat', false)}
            <button
              type="button"
              className="btn wide"
              style={{ marginTop: '12px' }}
              onClick={() => {
                navigateTo('learn');
                setLearnTab('Words');
                setLearnIndex(0);
              }}
            >
              သင်ခန်းစာ စတင်ရန် →
            </button>
          </div>
        )}

        {/* LEARN PAGE */}
        {page === 'learn' && (
          <div>
            {learnTab === 'Q & A' ? (
              <div>
                <div className="section-head">
                  <h2>မေးခွန်းနှင့် အဖြေ · Q & A (လေ့ကျင့်ရန်)</h2>
                  <span className="counter">{qaIndex + 1} / {qaLessons.length}</span>
                </div>
                {/* Learn Tab bar */}
                <div className="controls" style={{ marginBottom: '14px' }}>
                  {(['Words', 'Sentences', 'Q & A', 'Grammar'] as const).map(tabName => (
                    <button
                      key={tabName}
                      type="button"
                      className={`btn ${learnTab === tabName ? '' : 'secondary'}`}
                      onClick={() => {
                        setLearnTab(tabName);
                        setLearnIndex(0);
                      }}
                    >
                      {tabName}
                    </button>
                  ))}
                </div>
                <p className="section-intro">
                  ဤအမေး/အဖြေ ၁၀ တွဲသည် Unit 8 ဝါကျများကို အခြေခံ၍ လေ့ကျင့်ရန် စီစဉ်ထားခြင်းဖြစ်ပြီး စာအုပ်တွင် သီးသန့်ဖော်ပြထားသော အမေး/အဖြေမဟုတ်ပါ။ တစ်ကြောင်းချင်း နားထောင်ပြီး လိုက်ပြောပါ။ ဖြေရန် မလိုပါ။
                </p>
                <div className="card">
                  <div className="qa-item">
                    <span className="tag">Q · မေးခွန်း</span>
                    <div className="thai" lang="th">{qaLessons[qaIndex][0]}</div>
                    <div className="phonetic">{schoolPhonetics[qaLessons[qaIndex][0]] || ''}</div>
                    <div className="mm" lang="my">{qaLessons[qaIndex][2]}</div>
                    {renderActions(qaLessons[qaIndex][0], true, `qaQ-${qaIndex}`)}
                  </div>
                  <div className="qa-divider">↓ Answer · အဖြေ</div>
                  <div className="qa-item">
                    <span className="tag">A · အဖြေ</span>
                    <div className="thai" lang="th">{qaLessons[qaIndex][1]}</div>
                    <div className="phonetic">{schoolPhonetics[qaLessons[qaIndex][1]] || ''}</div>
                    <div className="mm" lang="my">{qaLessons[qaIndex][3]}</div>
                    {renderActions(qaLessons[qaIndex][1], true, `qaA-${qaIndex}`)}
                  </div>
                </div>
                <div className="controls">
                  <button type="button" className="btn secondary" onClick={() => stepQA(-1)}>
                    ← အရင်တစ်ခု
                  </button>
                  <button type="button" className="btn" onClick={() => stepQA(1)}>
                    နောက်တစ်ခု →
                  </button>
                </div>
                {statusMessage && <p className="footnote">{statusMessage}</p>}
              </div>
            ) : learnTab === 'Grammar' ? (
              <div>
                <div className="section-head">
                  <h2>သဒ္ဒါ · Grammar</h2>
                  <span className="counter">{unit8GrammarPatterns.length} patterns</span>
                </div>
                <div className="controls" style={{ marginBottom: '14px' }}>
                  {(['Words', 'Sentences', 'Q & A', 'Grammar'] as const).map(tabName => (
                    <button
                      key={tabName}
                      type="button"
                      className={`btn ${learnTab === tabName ? '' : 'secondary'}`}
                      onClick={() => {
                        setLearnTab(tabName);
                        setLearnIndex(0);
                      }}
                    >
                      {tabName}
                    </button>
                  ))}
                </div>
                <p className="section-intro">
                  အခန်း (၈) စာအုပ်မှ ဝါကျများတွင် ပါဝင်သော သဒ္ဒါပုံစံများကို စုစည်းထားပါသည်။ ခေါင်းစဉ်ကို နှိပ်ပြီး ထိုင်းစာ၊ အသံထွက်နှင့် မြန်မာအဓိပ္ပာယ်ကို လေ့လာပါ။
                </p>
                {unit8GrammarPatterns.map((g, j) => {
                  const examples = g.examples
                    .map(t => sentences.find(s => s[0] === t) || words.find(w => w[0] === t))
                    .filter(Boolean) as (WordEntry | SentenceEntry)[];

                  return (
                    <details key={j} className="grammar-accordion" open={j === 0}>
                      <summary>{j + 1}. {g.title}</summary>
                      <div className="grammar-body">
                        <h3 style={{ marginTop: '15px' }}>{g.formula}</h3>
                        <p className="muted">{g.explain}</p>
                        {examples.map((x, exIdx) => (
                          <div key={exIdx} style={{ padding: '15px 0', borderTop: '1px solid #efe7f1' }}>
                            <div className="thai" style={{ fontSize: '23px' }}>{x[0]}</div>
                            <div className="phonetic">{x[1]}</div>
                            <div className="mm">{x[2]}</div>
                            {renderActions(x[0], false)}
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            ) : (
              <div>
                {/* Words or Sentences Tab */}
                {(() => {
                  const arr = learnTab === 'Words' ? words : sentences;
                  const item = arr[Math.min(learnIndex, arr.length - 1)];
                  return (
                    <div>
                      <div className="section-head">
                        <h2>နားထောင်ပြီး လိုက်ပြောပါ</h2>
                        <span className="counter">{learnIndex + 1} / {arr.length}</span>
                      </div>
                      <div className="controls" style={{ marginBottom: '14px' }}>
                        {(['Words', 'Sentences', 'Q & A', 'Grammar'] as const).map(tabName => (
                          <button
                            key={tabName}
                            type="button"
                            className={`btn ${learnTab === tabName ? '' : 'secondary'}`}
                            onClick={() => {
                              setLearnTab(tabName);
                              setLearnIndex(0);
                            }}
                          >
                            {tabName}
                          </button>
                        ))}
                      </div>
                      {renderCardBox(item, item[3], true, `learn-${learnTab}-${learnIndex}`)}
                      <div className="controls">
                        <button type="button" className="btn secondary" onClick={() => stepLearn(-1)}>
                          ← ရှေ့သို့
                        </button>
                        <button type="button" className="btn" onClick={() => stepLearn(1)}>
                          နောက်တစ်ခု →
                        </button>
                      </div>
                      {statusMessage && <p className="footnote">{statusMessage}</p>}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* PRACTICE PAGE */}
        {page === 'practice' && (
          <div>
            <div className="section-head">
              <h2>Practice · လေ့ကျင့်ခန်း</h2>
            </div>
            <div className="rows practice-tiles" style={{ marginBottom: '16px' }}>
              <button
                type="button"
                className="tile"
                style={{
                  background: practice === 'quiz' ? '#fff9d4' : 'white',
                  borderColor: practice === 'quiz' ? '#e7d968' : '#dfece4'
                }}
                onClick={() => {
                  setPractice('quiz');
                  restartQuiz();
                }}
              >
                📝 <strong>Unit 8 Quiz</strong>
                <small>သင်ယူထားသည်ကို စမ်းစစ်ပါ</small>
              </button>
              <button
                type="button"
                className="tile"
                style={{
                  background: practice === 'blank' ? '#fff9d4' : 'white',
                  borderColor: practice === 'blank' ? '#e7d968' : '#dfece4'
                }}
                onClick={() => {
                  setPractice('blank');
                  setFillIndex(0);
                  setFillChoice(null);
                  setFillChecked(false);
                }}
              >
                🎧 <strong>Listen & Fill</strong>
                <small>နားထောင်ပြီး ဖြည့်ပါ</small>
              </button>
              <button
                type="button"
                className="tile"
                style={{
                  background: practice === 'rearrange' ? '#fff9d4' : 'white',
                  borderColor: practice === 'rearrange' ? '#e7d968' : '#dfece4'
                }}
                onClick={() => {
                  setPractice('rearrange');
                  setReorderIndex(0);
                  setReorderPicked([]);
                  setReorderChecked(false);
                }}
              >
                🧩 <strong>Rearrange Sentence</strong>
                <small>စကားလုံးများကို အစီအစဉ်မှန် စီပါ</small>
              </button>
            </div>

            {/* Sub-exercise: QUIZ */}
            {practice === 'quiz' && (
              <div>
                {quizIndex >= quizQuestions.length ? (
                  <div className="card quiz-finish">
                    <div className="bigscore">
                      {Math.round((quizScore / quizQuestions.length) * 100)}%
                    </div>
                    <h2>Unit 8 Quiz ပြီးပါပြီ!</h2>
                    <p className="mm">{quizScore} / {quizQuestions.length} မှန်ပါတယ်။</p>
                    <p className="muted">မှားခဲ့သော မေးခွန်းများကို ပြန်ကြည့်ပြီး နောက်တစ်ကြိမ် စမ်းကြည့်နိုင်ပါတယ်။</p>
                    {quizResponses
                      .filter(x => !x.correct)
                      .map(x => (
                        <div key={x.index} className="quiz-review">
                          <strong>{quizQuestions[x.index].q}</strong>
                          <p className="muted">{quizQuestions[x.index].why}</p>
                        </div>
                      ))}
                    <button type="button" className="btn wide" onClick={restartQuiz} style={{ marginTop: '16px' }}>
                      🔄 Quiz ပြန်ဖြေရန်
                    </button>
                  </div>
                ) : (
                  (() => {
                    const q = quizQuestions[quizIndex];
                    const picked = quizResponses.find(x => x.index === quizIndex);
                    return (
                      <div className="card">
                        <span className="tag">Unit 8 Quiz · {quizIndex + 1} / {quizQuestions.length}</span>
                        <div className="quiz-progress">
                          <span style={{ width: `${(100 * quizIndex) / quizQuestions.length}%` }}></span>
                        </div>
                        <h3 className="quiz-question">{q.q}</h3>
                        {q.audio && (
                          <div className="controls" style={{ marginBottom: '12px' }}>
                            <button type="button" className="btn" onClick={() => speak(q.audio!)}>
                              🔊 အသံနားထောင်ပါ
                            </button>
                            <button type="button" className="btn secondary" onClick={() => speak(q.audio!, 0.7)}>
                              🐢 ဖြည်းဖြည်း
                            </button>
                          </div>
                        )}
                        <div className="stack" style={{ marginTop: '17px' }}>
                          {q.choices.map((opt, j) => {
                            let stateClass = '';
                            if (picked) {
                              if (j === q.correct) stateClass = 'correct';
                              else if (j === picked.choice) stateClass = 'incorrect';
                            }
                            return (
                              <button
                                key={j}
                                type="button"
                                className={`quiz-option ${stateClass}`}
                                disabled={Boolean(picked)}
                                onClick={() => handleQuizChoice(j)}
                              >
                                {String.fromCharCode(65 + j)}. {opt}
                              </button>
                            );
                          })}
                        </div>
                        {picked ? (
                          <>
                            <div className="quiz-feedback">
                              {picked.correct ? '✅ မှန်ပါတယ်!' : '❌ လေ့လာပြီး ထပ်စမ်းကြည့်ပါ။'}
                              <p>{q.why}</p>
                            </div>
                            <button type="button" className="btn wide" onClick={nextQuizQuestion}>
                              {quizIndex === quizQuestions.length - 1 ? 'ရလဒ် ကြည့်ရန် →' : 'နောက်မေးခွန်း →'}
                            </button>
                          </>
                        ) : (
                          <p className="muted" style={{ marginTop: '12px' }}>အဖြေတစ်ခုကို ရွေးပါ။</p>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>
            )}

            {/* Sub-exercise: LISTEN & FILL */}
            {practice === 'blank' && (
              (() => {
                const q = blanks[fillIndex % blanks.length];
                const correctIdx = q.choices.indexOf(q.answer);

                return (
                  <div className="card fill-card">
                    <span className="tag">🎧 Listen & Fill · {(fillIndex % blanks.length) + 1} / {blanks.length}</span>
                    <p className="section-intro">
                      အသံကို နားထောင်ပြီး အဖြေမှန်ကို ရွေးပါ။ <strong>ထိုင်းစာဖတ်တတ်ရန် မလိုပါ။</strong> ကတ်တစ်ခုစီတွင် ထိုင်းစာ၊ စာအုပ်သုံး phonetic၊ မြန်မာအသံထွက်နှင့် မြန်မာအဓိပ္ပာယ် ပါရှိသည်။
                    </p>
                    <div className="fill-prompt">
                      <span className="fill-prompt-label">မြန်မာအဓိပ္ပာယ်</span>
                      <div className="mm" lang="my">{q.meaning}</div>
                      <div className="fill-blank-line" lang="th">{q.blank}</div>
                    </div>

                    <div className="controls">
                      <button type="button" className="btn" onClick={() => speak(q.full)}>
                        🔊 နားထောင်ပါ
                      </button>
                      <button type="button" className="btn secondary" onClick={() => speak(q.full, 0.7)}>
                        🐢 ဖြည်းဖြည်း
                      </button>
                    </div>

                    <h3 className="fill-heading">အဖြေတစ်ခုကို ရွေးပါ။</h3>
                    <div className="fill-options" role="group" aria-label="Listen and Fill multiple choices">
                      {q.choices.map((word, j) => {
                        const entry = fillVocabulary[word] || ['/…/', '…', '…'];
                        let stateClass = '';
                        if (fillChecked) {
                          if (j === correctIdx) stateClass = ' is-correct';
                          else if (j === fillChoice) stateClass = ' is-wrong';
                        } else if (fillChoice === j) {
                          stateClass = ' is-selected';
                        }

                        return (
                          <button
                            key={j}
                            type="button"
                            className={`fill-choice${stateClass}`}
                            onClick={() => handleFillChoice(j)}
                            disabled={fillChecked}
                            aria-pressed={fillChoice === j}
                            aria-label={`${word} · ${entry[2]}`}
                          >
                            <span className="fill-number">{String.fromCharCode(65 + j)}</span>
                            <span className="fill-lines">
                              <span className="fill-thai" lang="th">{word}</span>
                              <span className="fill-phonetic">{entry[0]}</span>
                              <span className="fill-pronunciation" lang="my">{entry[1]}</span>
                              <span className="fill-meaning" lang="my">{entry[2]}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {!fillChecked ? (
                      <button
                        type="button"
                        className="btn wide"
                        onClick={checkFill}
                        disabled={fillChoice === null}
                      >
                        အဖြေစစ်ဆေးပါ
                      </button>
                    ) : (
                      <div
                        className={`fill-feedback ${fillChoice === correctIdx ? 'good' : 'retry'}`}
                        role="status"
                      >
                        <strong>
                          {fillChoice === correctIdx ? '✅ မှန်ပါတယ်!' : '📖 အဖြေမှန်ကို လေ့လာပါ။'}
                        </strong>
                        <p>
                          {fillChoice === correctIdx
                            ? 'အသံကို မှန်ကန်စွာ ရွေးချယ်နိုင်ပါတယ်။'
                            : 'မှားသောအဖြေကို ပြထားပြီး အဖြေမှန်ကို အစိမ်းရောင်ဖြင့် ပြထားပါတယ်။'}
                        </p>
                        <div className="fill-fully">
                          <div className="thai" lang="th">{q.full}</div>
                          <div className="phonetic">{schoolPhonetics[q.full] || ''}</div>
                          <div className="mm" lang="my">{q.meaning}</div>
                        </div>
                        <div className="controls" style={{ marginTop: '14px' }}>
                          <button type="button" className="btn secondary" onClick={retryFill}>
                            ↺ ပြန်လေ့ကျင့်ရန်
                          </button>
                          <button type="button" className="btn" onClick={completeFillExercise}>
                            {fillIndex === blanks.length - 1 ? 'အစက ပြန်လေ့ကျင့်ရန်' : 'နောက်မေးခွန်း →'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()
            )}

            {/* Sub-exercise: REARRANGE SENTENCE */}
            {practice === 'rearrange' && (
              <div className="card">
                <span className="tag">Rearrange Sentence · {reorderIndex + 1} / {rearrangeLessons.length}</span>
                <p className="section-intro">
                  မြန်မာအဓိပ္ပာယ်ကို ဖတ်ပြီး ထိုင်းစကားလုံးများကို အစီအစဉ်မှန် စီပါ။ ကတ်တစ်ခုစီတွင် ထိုင်းစာ၊ စာအုပ်သုံး phonetic နှင့် မြန်မာအသံထွက် ပါရှိသည်။
                </p>
                <div className="reorder-prompt">
                  <strong>မြန်မာအဓိပ္ပာယ်</strong>
                  <div className="mm">{currentRearrange.meaning}</div>
                </div>

                <div className="controls">
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => speak(currentRearrange.parts.map(p => p[0]).join(''))}
                  >
                    🔊 နားထောင်ပါ
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => speak(currentRearrange.parts.map(p => p[0]).join(''), 0.7)}
                  >
                    🐢 အနှေးအသံ
                  </button>
                </div>

                {/* Area 1: Picked tokens in answer box */}
                <div className="reorder-area">
                  <h4>၁။ စီထားသော စကားလုံးများ (နှိပ်၍ ပြန်ဖြုတ်နိုင်ပါသည်)</h4>
                  <div className="reorder-tiles" id="reorderAnswer">
                    {reorderPicked.length > 0 ? (
                      reorderPicked.map(id => {
                        const part = currentRearrange.parts[id];
                        return (
                          <button
                            key={id}
                            type="button"
                            className="reorder-token selected"
                            onClick={() => removeRearranged(id)}
                            aria-label={`Remove ${part[0]}`}
                          >
                            <span className="reorder-thai" lang="th">{part[0]}</span>
                            <span className="reorder-phon">{part[1]}</span>
                            <span className="reorder-my" lang="my">{part[2]}</span>
                          </button>
                        );
                      })
                    ) : (
                      <div className="reorder-empty">အောက်က ကတ်များကို အစဉ်လိုက် နှိပ်ပါ။</div>
                    )}
                  </div>
                </div>

                {/* Area 2: Available bank tokens */}
                <div className="reorder-bank">
                  <h4>၂။ စကားလုံးကတ်များ</h4>
                  <div className="reorder-tiles" id="reorderChoices">
                    {availableTokens.length > 0 ? (
                      availableTokens.map(id => {
                        const part = currentRearrange.parts[id];
                        return (
                          <button
                            key={id}
                            type="button"
                            className="reorder-token"
                            onClick={() => pickRearranged(id)}
                            aria-label={`Choose ${part[0]}`}
                          >
                            <span className="reorder-thai" lang="th">{part[0]}</span>
                            <span className="reorder-phon">{part[1]}</span>
                            <span className="reorder-my" lang="my">{part[2]}</span>
                          </button>
                        );
                      })
                    ) : (
                      <span className="muted">စကားလုံးအားလုံး စီပြီးပါပြီ။</span>
                    )}
                  </div>
                </div>

                {/* Feedback */}
                {reorderChecked && (
                  isRearrangeCorrect ? (
                    <div>
                      <div className="reorder-status good" role="status">
                        <strong>✅ မှန်ပါတယ်!</strong> စာကြောင်းကို မှန်ကန်စွာ စီထားပါတယ်။
                      </div>
                      <div className="reorder-complete">
                        <div className="thai" lang="th">
                          {currentRearrange.parts.map(p => p[0]).join('')}
                        </div>
                        <div className="phonetic">
                          {'/' + currentRearrange.parts.map(p => p[1].replaceAll('/', '')).join('-') + '/'}
                        </div>
                        <div className="mm">{currentRearrange.meaning}</div>
                      </div>
                    </div>
                  ) : (
                    <div className="reorder-status try" role="status">
                      အစီအစဉ် မမှန်သေးပါ။ စကားလုံးကို နှိပ်ပြီး ပြန်ရွှေ့နိုင်ပါတယ်။
                    </div>
                  )
                )}

                <div className="reorder-controls">
                  <button type="button" className="btn secondary" onClick={resetRearranged}>
                    ↺ ပြန်စီရန်
                  </button>
                  {isRearrangeCorrect ? (
                    <button type="button" className="btn" onClick={nextRearranged}>
                      {reorderIndex === rearrangeLessons.length - 1 ? 'နောက်တစ်ကြိမ် လေ့ကျင့်ရန်' : 'နောက်ဝါကျ →'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      onClick={checkRearranged}
                      disabled={!isRearrangeComplete}
                    >
                      ✓ အဖြေစစ်ရန်
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* FLASHCARDS PAGE */}
        {page === 'flash' && (
          <div>
            <div className="section-head">
              <h2>Flashcards · မှတ်သားလေ့ကျင့်</h2>
              <span className="counter">{flashIndex + 1} / {words.length}</span>
            </div>
            <div
              className="card"
              style={{
                textAlign: 'center',
                minHeight: '310px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer'
              }}
              onClick={flipCard}
            >
              <span className="tag">{flashBack ? 'Meaning' : 'Thai word'}</span>
              {flashBack ? (
                <div className="mm" style={{ fontSize: '26px' }}>{words[flashIndex][2]}</div>
              ) : (
                <>
                  <div className="thai">{words[flashIndex][0]}</div>
                  <div className="phonetic">{words[flashIndex][1]}</div>
                </>
              )}
              <p className="muted" style={{ marginTop: '16px' }}>ကတ်ကိုနှိပ်ပြီး လှန်ကြည့်ပါ</p>
            </div>
            <div className="controls">
              <button
                type="button"
                className="btn secondary"
                onClick={(e) => {
                  e.stopPropagation();
                  speak(words[flashIndex][0]);
                }}
              >
                🔊 နားထောင်ပါ
              </button>
              <button type="button" className="btn ghost" onClick={() => stepFlash(-1)}>
                ← ရှေ့သို့
              </button>
              <button type="button" className="btn" onClick={() => stepFlash(1)}>
                နောက်တစ်ခု →
              </button>
            </div>
          </div>
        )}

        {/* SETTINGS PAGE */}
        {page === 'settings' && (
          <div>
            <h2>⚙️ အသံနှင့် app settings</h2>
            <div className="card">
              <h3>Thai voice · အသံ</h3>
              <p className="muted">Thai voice selection depends on the browser and operating system.</p>
              <div className="notice" style={{ marginTop: '8px', marginBottom: '14px' }}>
                {detectedVoices || 'Checking Thai voices on your device...'}
              </div>
              <label htmlFor="rate" style={{ display: 'block', fontWeight: 600, marginBottom: '6px' }}>
                Audio speed · <span>{speed}</span>×
              </label>
              <input
                id="rate"
                type="range"
                min="0.5"
                max="1.1"
                step="0.05"
                value={speed}
                style={{ width: '100%' }}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setSpeed(val);
                  safeSet('thaiSpeed', String(val));
                }}
              />
              <div className="controls" style={{ marginTop: '14px' }}>
                <button type="button" className="btn" onClick={() => speak('สวัสดีครับ')}>
                  🔊 Thai အသံ စမ်းနားထောင်ရန်
                </button>
              </div>
            </div>

            <div className="card">
              <h3>Install on phone</h3>
              <p className="muted">
                Open the hosted site in Chrome on Android or Safari on iPhone, then use Add to Home Screen / Install App.
              </p>
              <p className="small">
                A PWA needs HTTPS or localhost. The current preview can be installed to home screen when accessed directly in your phone browser.
              </p>
            </div>

            <div className="card">
              <h3>Student progress</h3>
              <p className="muted">Saved on this device, not synchronized with a school account.</p>
              <button
                type="button"
                className="btn secondary"
                style={{ marginTop: '10px' }}
                onClick={() => {
                  if (confirm('Reset your progress?')) {
                    setDone([]);
                    safeRemove('thaiDoneUnit8V4');
                  }
                }}
              >
                Reset progress
              </button>
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Navigation */}
      <nav className="nav" id="nav">
        <button
          type="button"
          data-page="home"
          className={page === 'home' ? 'active' : ''}
          onClick={() => navigateTo('home')}
        >
          <span className="ico">⌂</span>ပင်မ
        </button>
        <button
          type="button"
          data-page="learn"
          className={page === 'learn' ? 'active' : ''}
          onClick={() => navigateTo('learn')}
        >
          <span className="ico">◉</span>လေ့လာ
        </button>
        <button
          type="button"
          data-page="practice"
          className={page === 'practice' ? 'active' : ''}
          onClick={() => navigateTo('practice')}
        >
          <span className="ico">✦</span>လေ့ကျင့်
        </button>
        <button
          type="button"
          data-page="flash"
          className={page === 'flash' ? 'active' : ''}
          onClick={() => navigateTo('flash')}
        >
          <span className="ico">▣</span>ကတ်များ
        </button>
        <button
          type="button"
          data-page="settings"
          className={page === 'settings' ? 'active' : ''}
          onClick={() => navigateTo('settings')}
        >
          <span className="ico">⚙</span>ချိန်ညှိ
        </button>
      </nav>
    </div>
  );
}
