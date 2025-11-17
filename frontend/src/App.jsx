import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

const normalizeText = (text) =>
  text.trim().toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ')

async function apiFetch(path, options = {}) {
  const fetchOptions = {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  }
  if (fetchOptions.body && typeof fetchOptions.body !== 'string') {
    fetchOptions.body = JSON.stringify(fetchOptions.body)
  }
  const response = await fetch(`${API_BASE}${path}`, fetchOptions)
  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const payload = isJson ? await response.json() : await response.text()
  if (!response.ok) {
    const detail = isJson ? payload?.detail : payload
    throw new Error(detail || 'Prišlo je do napake pri komunikaciji z API.')
  }
  return payload
}

const emptyAnswers = (labels = []) => labels.map(() => '')

function App() {
  const [users, setUsers] = useState([])
  const [modules, setModules] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [selectedModule, setSelectedModule] = useState(null)
  const [newUserName, setNewUserName] = useState('')
  const [cycle, setCycle] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [answers, setAnswers] = useState([])
  const [questionStage, setQuestionStage] = useState('idle')
  const [evaluation, setEvaluation] = useState(null)
  const [solutionVisible, setSolutionVisible] = useState(false)
  const [error, setError] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  const [stats, setStats] = useState(null)
  const [isLoadingData, setIsLoadingData] = useState(false)

  const currentQuestion = cycle ? cycle.items[currentIndex] : null
  const isLastQuestion = cycle ? currentIndex === cycle.items.length - 1 : false

  const loadUsersAndModules = useCallback(async () => {
    setIsLoadingData(true)
    try {
      const [userData, moduleData] = await Promise.all([
        apiFetch('/users'),
        apiFetch('/modules'),
      ])
      setUsers(userData)
      setModules(moduleData)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoadingData(false)
    }
  }, [])

  useEffect(() => {
    loadUsersAndModules()
  }, [loadUsersAndModules])

  useEffect(() => {
    if (selectedUser && selectedModule) {
      loadStats(selectedModule)
    } else {
      setStats(null)
    }
  }, [selectedUser, selectedModule])

  useEffect(() => {
    if (currentQuestion) {
      setAnswers(emptyAnswers(currentQuestion.labels))
      setQuestionStage('idle')
      setEvaluation(null)
      setSolutionVisible(false)
      setError('')
    }
  }, [currentQuestion])

  const loadStats = async (wordType) => {
    if (!selectedUser) return
    try {
      const data = await apiFetch(`/users/${selectedUser.id}/stats?word_type=${wordType}`)
      setStats(data)
    } catch (err) {
      setError(err.message)
    }
  }

  const handleCreateUser = async (event) => {
    event.preventDefault()
    if (!newUserName.trim()) return
    setError('')
    try {
      const created = await apiFetch('/users', {
        method: 'POST',
        body: { name: newUserName.trim() },
      })
      setUsers((prev) => [...prev, created])
      setSelectedUser(created)
      setNewUserName('')
    } catch (err) {
      setError(err.message)
    }
  }

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Ali res želiš izbrisati tega uporabnika?')) return
    setError('')
    setIsBusy(true)
    try {
      await apiFetch(`/users/${userId}`, { method: 'DELETE' })
      setUsers((prev) => prev.filter((user) => user.id !== userId))
      if (selectedUser?.id === userId) {
        setSelectedUser(null)
        setCycle(null)
        setStats(null)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setIsBusy(false)
    }
  }

  const handleStartCycle = async () => {
    if (!selectedUser || !selectedModule) return
    setIsBusy(true)
    setError('')
    try {
      const data = await apiFetch('/cycles', {
        method: 'POST',
        body: {
          user_id: selectedUser.id,
          word_type: selectedModule,
          include_solutions: true,
        },
      })
      setCycle(data)
      setCurrentIndex(0)
      setAnswers(emptyAnswers(data.items[0]?.labels))
      setQuestionStage('idle')
      setEvaluation(null)
      setSolutionVisible(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsBusy(false)
    }
  }

  const recordAttempt = async (revealedFlag, answersPayload) => {
    if (!selectedUser || !selectedModule || !currentQuestion || !cycle) return
    setIsBusy(true)
    setError('')
    try {
      await apiFetch('/attempts', {
        method: 'POST',
        body: {
          user_id: selectedUser.id,
          item_id: currentQuestion.id,
          word_type: selectedModule,
          answers: answersPayload,
          revealed: revealedFlag,
          cycle_number: cycle.cycle_number,
        },
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setIsBusy(false)
    }
  }

  const answersMatchSolution = () => {
    if (!currentQuestion?.solution) return false
    const normalizedAnswers = answers.map((value) => normalizeText(value || ''))
    const normalizedSolution = currentQuestion.solution.map((value) =>
      normalizeText(value || ''),
    )
    return normalizedAnswers.every((value, index) => value === normalizedSolution[index])
  }

  const handleRevealNow = async () => {
    setSolutionVisible(true)
    setEvaluation({
      correct: false,
      message: 'Pogledal si rešitev. Zapiše se kot pomoč.',
    })
    await recordAttempt(true, answers)
    setQuestionStage('final')
  }

  const handleValidateAnswers = async () => {
    if (!currentQuestion) return
    const isCorrect = answersMatchSolution()
    if (isCorrect) {
      setEvaluation({ correct: true, message: 'Odlično! Odgovor je pravilen.' })
      await recordAttempt(false, answers)
      setQuestionStage('final')
    } else {
      setEvaluation({
        correct: false,
        message: 'Odgovor ni pravilen. Lahko pogledaš rešitev ali nadaljuješ.',
      })
      setQuestionStage('answered-wrong')
    }
  }

  const finalizeWrong = async (showSolution) => {
    if (showSolution) {
      setSolutionVisible(true)
    }
    await recordAttempt(showSolution, answers)
    setQuestionStage('final')
  }

  const handleAdvance = async () => {
    if (!cycle) return
    if (isLastQuestion) {
      await completeCycle()
    } else {
      setCurrentIndex((prev) => prev + 1)
    }
  }

  const completeCycle = async () => {
    if (!selectedUser || !selectedModule || !cycle) return
    setIsBusy(true)
    setError('')
    try {
      await apiFetch('/cycles/complete', {
        method: 'POST',
        body: {
          user_id: selectedUser.id,
          word_type: selectedModule,
        },
      })
      await loadStats(selectedModule)
      setCycle(null)
      setCurrentIndex(0)
      setAnswers([])
      setEvaluation(null)
      setQuestionStage('idle')
      setSolutionVisible(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsBusy(false)
    }
  }

  const currentCycleInfo = useMemo(() => {
    if (!cycle) return null
    return `Cikel #${cycle.cycle_number} (${cycle.mode})`
  }, [cycle])

  const renderQuestion = () => {
    if (!currentQuestion) {
      return (
        <div className="empty-state">
          <p>Izberi modul in zaženi cikel, da dobiš vprašanja.</p>
        </div>
      )
    }

    return (
      <div className="question-card">
        <div className="question-meta">
          <span>{currentCycleInfo}</span>
          <span>
            Vprašanje {currentIndex + 1}/{cycle.items.length}
          </span>
          <span>{selectedModule === 'noun' ? 'Samostalnik' : 'Nepravilni glagol'}</span>
        </div>
        <div className="translation">
          <p>Pomen v slovenščini:</p>
          <h3>{currentQuestion.translation}</h3>
        </div>
        <div className="inputs">
          {currentQuestion.labels.map((label, index) => (
            <label key={label} className="input-row">
              <span>{label}</span>
              <input
                type="text"
                value={answers[index] ?? ''}
                onChange={(event) => {
                  const value = event.target.value
                  setAnswers((prev) => {
                    const copy = [...prev]
                    copy[index] = value
                    return copy
                  })
                }}
                disabled={questionStage !== 'idle'}
              />
            </label>
          ))}
        </div>
        <div className="actions">
          {questionStage === 'idle' && (
            <>
              <button
                className="btn primary"
                onClick={handleValidateAnswers}
                disabled={isBusy}
              >
                Preveri odgovor
              </button>
              <button className="btn ghost" onClick={handleRevealNow} disabled={isBusy}>
                Ne vem – pokaži odgovor
              </button>
            </>
          )}
          {questionStage === 'answered-wrong' && (
            <>
              <button className="btn" onClick={() => finalizeWrong(false)} disabled={isBusy}>
                Naprej brez rešitve
              </button>
              <button
                className="btn warning"
                onClick={() => finalizeWrong(true)}
                disabled={isBusy}
              >
                Pokaži rešitev
              </button>
            </>
          )}
          {questionStage === 'final' && (
            <button className="btn primary" onClick={handleAdvance} disabled={isBusy}>
              {isLastQuestion ? 'Zaključi cikel' : 'Naslednje vprašanje'}
            </button>
          )}
        </div>
        {evaluation && (
          <div className={`status ${evaluation.correct ? 'success' : 'danger'}`}>
            {evaluation.message}
          </div>
        )}
        {solutionVisible && currentQuestion.solution && (
          <div className="solution-panel">
            <h4>Pravilne oblike</h4>
            <ul>
              {currentQuestion.solution.map((value, index) => (
                <li key={`${value}-${index}`}>
                  <span>{currentQuestion.labels[index]}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <div>
          <p className="kicker">Nemški trener</p>
          <h1>Samostalniki & nepravilni glagoli</h1>
        </div>
        <div className="header-actions">
          <div className="api-indicator">
            API: <span>{API_BASE}</span>
          </div>
          <button
            className="btn ghost"
            onClick={loadUsersAndModules}
            disabled={isLoadingData}
          >
            {isLoadingData ? 'Osvežujem...' : 'Osveži podatke'}
          </button>
        </div>
      </header>

      {error && <div className="alert danger">{error}</div>}

      <section className="panel-grid">
        <div className="panel">
          <h2>1. Izberi uporabnika</h2>
          {isLoadingData && <p className="hint">Nalagam uporabnike in sklope ...</p>}
          {users.length === 0 ? (
            <p>Začni tako, da ustvariš prvega uporabnika.</p>
          ) : (
            <div className="pill-list">
              {users.map((user) => {
                const isActive = selectedUser?.id === user.id
                return (
                  <div
                    key={user.id}
                    className={`pill ${isActive ? 'active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedUser(user)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        setSelectedUser(user)
                      }
                    }}
                  >
                    <div>
                      <span>{user.name}</span>
                      <span className="pill-meta">ID: {user.id}</span>
                    </div>
                    <button
                      type="button"
                      className="remove-btn"
                      onClick={(event) => {
                        event.stopPropagation()
                        handleDeleteUser(user.id)
                      }}
                      disabled={isBusy}
                      aria-label={`Izbriši uporabnika ${user.name}`}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          <form className="inline-form" onSubmit={handleCreateUser}>
            <input
              type="text"
              placeholder="Novo ime"
              value={newUserName}
              onChange={(event) => setNewUserName(event.target.value)}
            />
            <button type="submit" className="btn secondary">
              Dodaj
            </button>
          </form>
        </div>

        <div className="panel">
          <h2>2. Izberi sklop</h2>
          <div className="pill-list">
            {modules.map((module) => (
              <button
                key={module.type}
                className={`pill ${selectedModule === module.type ? 'active' : ''}`}
                onClick={() => setSelectedModule(module.type)}
              >
                <strong>{module.label}</strong>
                <span>{module.description}</span>
              </button>
            ))}
          </div>
          <button
            className="btn primary full"
            onClick={handleStartCycle}
            disabled={!selectedUser || !selectedModule || isBusy}
          >
            Zaženi nov cikel
          </button>
          {stats && (
            <div className="stats-box">
              <h3>Statistika ({stats.word_type === 'noun' ? 'samostalniki' : 'glagoli'})</h3>
              <ul>
                <li>
                  Poskusi: <strong>{stats.attempts}</strong>
                </li>
                <li>
                  ✅ Pravilnih: <strong>{stats.correct}</strong>
                </li>
                <li>
                  ❌ Napačnih: <strong>{stats.wrong}</strong>
                </li>
                <li>
                  👀 Pogledi: <strong>{stats.reveals}</strong>
                </li>
                <li>
                  Uspešnost:{' '}
                  <strong>{(stats.accuracy * 100 || 0).toFixed(1)}%</strong>
                </li>
                <li>
                  Zaključeni cikli: <strong>{stats.cycle_count}</strong>
                </li>
              </ul>
            </div>
          )}
        </div>
      </section>

      <section>{renderQuestion()}</section>
    </div>
  )
}

export default App
