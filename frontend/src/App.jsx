import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'

const normalizeText = (text) =>
  text.trim().toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ')

async function apiFetch(path, options = {}) {
  const isFormData =
    typeof FormData !== 'undefined' && options.body instanceof FormData
  const defaultHeaders = isFormData ? {} : { 'Content-Type': 'application/json' }
  const headers = { ...defaultHeaders, ...(options.headers || {}) }
  const fetchOptions = {
    ...options,
    headers,
  }
  if (fetchOptions.body && typeof fetchOptions.body !== 'string' && !isFormData) {
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
  const [importSummary, setImportSummary] = useState(null)
  const [isImporting, setIsImporting] = useState(false)
  const [moduleItemsType, setModuleItemsType] = useState(null)
  const [moduleItems, setModuleItems] = useState([])
  const [isLoadingItems, setIsLoadingItems] = useState(false)
  const [retryItem, setRetryItem] = useState(null)
  const [editingItemId, setEditingItemId] = useState(null)
  const [editValues, setEditValues] = useState({ translation: '', forms: [] })
  const [itemActionLoading, setItemActionLoading] = useState(false)
  const nounInputRef = useRef(null)
  const verbInputRef = useRef(null)

  const refreshModules = useCallback(async () => {
    const moduleData = await apiFetch('/modules')
    setModules(moduleData)
  }, [])

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

  const triggerCsvDialog = (wordType) => {
    const ref = wordType === 'noun' ? nounInputRef : verbInputRef
    if (ref.current) {
      ref.current.value = ''
      ref.current.click()
    }
  }

  const handleCsvFileChange = (wordType, event) => {
    const file = event.target.files?.[0]
    if (!file) return
    uploadCsv(wordType, file)
  }

  const cancelEditing = () => {
    setEditingItemId(null)
    setEditValues({ translation: '', forms: [] })
  }

  const startEditingItem = (item) => {
    const requiredForms = moduleItemsType === 'noun' ? 1 : 4
    const forms = item.solution && item.solution.length ? [...item.solution] : []
    while (forms.length < requiredForms) {
      forms.push('')
    }
    setEditingItemId(item.id)
    setEditValues({
      translation: item.translation || '',
      forms,
    })
  }

  const handleFormChange = (index, value) => {
    setEditValues((prev) => {
      const next = [...prev.forms]
      next[index] = value
      return { ...prev, forms: next }
    })
  }

  const saveItemChanges = async (itemId) => {
    setItemActionLoading(true)
    setError('')
    try {
      const payload = {
        translation: (editValues.translation || '').trim(),
        solution: editValues.forms.map((value) => (value || '').trim()),
      }
      const updated = await apiFetch(`/items/${itemId}`, {
        method: 'PUT',
        body: payload,
      })
      setModuleItems((prev) =>
        prev.map((item) => (item.id === itemId ? { ...item, ...updated } : item)),
      )
      cancelEditing()
    } catch (err) {
      setError(err.message)
    } finally {
      setItemActionLoading(false)
    }
  }

  const deleteItem = async (itemId) => {
    if (!window.confirm('Izbrišem ta zapis?')) return
    setItemActionLoading(true)
    setError('')
    try {
      await apiFetch(`/items/${itemId}`, { method: 'DELETE' })
      setModuleItems((prev) => prev.filter((item) => item.id !== itemId))
      if (editingItemId === itemId) {
        cancelEditing()
      }
      await refreshModules()
    } catch (err) {
      setError(err.message)
    } finally {
      setItemActionLoading(false)
    }
  }

  const uploadCsv = async (wordType, file) => {
    setImportSummary(null)
    setError('')
    setIsImporting(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const result = await apiFetch(`/import/${wordType}`, {
        method: 'POST',
        body: formData,
      })
      setImportSummary({
        ...result,
        fileName: file.name,
        wordType,
      })
      await refreshModules()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsImporting(false)
    }
  }

  const resetCycleState = () => {
    setCycle(null)
    setCurrentIndex(0)
    setAnswers([])
    setQuestionStage('idle')
    setEvaluation(null)
    setSolutionVisible(false)
    setRetryItem(null)
  }

  const toggleModuleItems = async (wordType) => {
    if (moduleItemsType === wordType) {
      setModuleItemsType(null)
      setModuleItems([])
      cancelEditing()
      return
    }
    setIsLoadingItems(true)
    setError('')
    try {
      const data = await apiFetch(`/items?word_type=${wordType}&include_solution=true`)
      setModuleItemsType(wordType)
      setModuleItems(data)
      cancelEditing()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoadingItems(false)
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
    setRetryItem(currentQuestion)
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
      setRetryItem(null)
    } else {
      setSolutionVisible(true)
      setEvaluation({
        correct: false,
        message: 'Odgovor ni pravilen. Prikazan je pravilen odgovor.',
      })
      setRetryItem(currentQuestion)
      await recordAttempt(true, answers)
      setQuestionStage('final')
    }
  }

  const handleAdvance = async () => {
    if (!cycle) return
    let items = cycle.items
    if (retryItem) {
      items = [...cycle.items]
      items.splice(currentIndex + 1, 0, retryItem)
      setCycle((prev) => (prev ? { ...prev, items } : prev))
      setRetryItem(null)
    }
    const nextIndex = currentIndex + 1
    if (nextIndex >= items.length) {
      await completeCycle()
    } else {
      setCurrentIndex(nextIndex)
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
      resetCycleState()
    } catch (err) {
      setError(err.message)
    } finally {
      setIsBusy(false)
    }
  }

  const cancelCycle = () => {
    if (!cycle) return
    if (!window.confirm('Prekinem trenutni cikel?')) return
    resetCycleState()
  }

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Enter') return
      if (questionStage === 'final' && cycle) {
        event.preventDefault()
        handleAdvance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [questionStage, cycle, handleAdvance])

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
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && questionStage === 'idle') {
                    event.preventDefault()
                    handleValidateAnswers()
                  }
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
                Preveri odgovor [Enter]
              </button>
              <button className="btn ghost" onClick={handleRevealNow} disabled={isBusy}>
                Ne vem – pokaži odgovor
              </button>
            </>
          )}
          {questionStage === 'final' && (
            <button className="btn primary" onClick={handleAdvance} disabled={isBusy}>
              {isLastQuestion ? 'Zaključi cikel [Enter]' : 'Naslednje vprašanje [Enter]'}
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
              <div key={module.type} className="module-row">
                <button
                  className={`pill ${selectedModule === module.type ? 'active' : ''}`}
                  onClick={() => setSelectedModule(module.type)}
                >
                  <strong>
                    {module.label} ({module.count})
                  </strong>
                </button>
                <button
                  type="button"
                  className="btn csv-btn"
                  onClick={() => triggerCsvDialog(module.type)}
                  disabled={isImporting}
                >
                  Uvozi CSV
                </button>
                <button
                  type="button"
                  className="btn outline-btn"
                  onClick={() => toggleModuleItems(module.type)}
                  disabled={isLoadingItems}
                >
                  Pokaži seznam
                </button>
              </div>
            ))}
            <input
              ref={nounInputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => handleCsvFileChange('noun', event)}
            />
            <input
              ref={verbInputRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => handleCsvFileChange('verb', event)}
            />
          </div>
          <button
            className="btn primary full"
            onClick={handleStartCycle}
            disabled={!selectedUser || !selectedModule || isBusy}
          >
            Zaženi nov cikel
          </button>
          {importSummary && (
            <div className="alert info">
              CSV ({importSummary.wordType === 'noun' ? 'samostalniki' : 'glagoli'}) –{' '}
              <strong>{importSummary.fileName}</strong> | dodanih {importSummary.added}, preskočenih{' '}
              {importSummary.skipped}
              {importSummary.errors?.length ? (
                <details>
                  <summary>Napake ({importSummary.errors.length})</summary>
                  <ul>
                    {importSummary.errors.slice(0, 5).map((msg) => (
                      <li key={msg}>{msg}</li>
                    ))}
                  </ul>
                  {importSummary.errors.length > 5 && <p>... in še {importSummary.errors.length - 5}</p>}
                </details>
              ) : null}
              <button type="button" className="close-alert" onClick={() => setImportSummary(null)}>
                ×
              </button>
            </div>
          )}
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
          {moduleItemsType && (
            <div
              className="modal-backdrop"
              onClick={(event) => {
                if (event.target.classList.contains('modal-backdrop')) {
                  setModuleItemsType(null)
                  setModuleItems([])
                  cancelEditing()
                }
              }}
            >
              <div className="modal">
                <div className="modal-header">
                  <h3>
                    {moduleItemsType === 'noun' ? 'Samostalniki' : 'Nepravilni glagoli'} · {moduleItems.length}
                  </h3>
                  <button
                    type="button"
                    className="close-modal"
                    onClick={() => {
                      setModuleItemsType(null)
                      setModuleItems([])
                      cancelEditing()
                    }}
                  >
                    ×
                  </button>
                </div>
                <div className="modal-body">
                  {isLoadingItems ? (
                    <p>Nalaganje ...</p>
                  ) : moduleItems.length === 0 ? (
                    <p>Trenutno ni zapisov.</p>
                  ) : (
                    <ul className="items-list">
                      {moduleItems.map((item) => {
                        const isEditing = editingItemId === item.id
                        const formLabels =
                          moduleItemsType === 'noun'
                            ? ['Člen + samostalnik']
                            : ['Infinitiv', '3. oseba ednine', 'Preterit', 'Perfekt']
                        return (
                          <li key={item.id}>
                            {isEditing ? (
                              <div className="edit-form">
                                <label>
                                  <span>Prevod</span>
                                  <input
                                    type="text"
                                    value={editValues.translation}
                                    onChange={(event) =>
                                      setEditValues((prev) => ({
                                        ...prev,
                                        translation: event.target.value,
                                      }))
                                    }
                                  />
                                </label>
                                {formLabels.map((label, index) => (
                                  <label key={label}>
                                    <span>{label}</span>
                                    <input
                                      type="text"
                                      value={editValues.forms[index] ?? ''}
                                      onChange={(event) =>
                                        handleFormChange(index, event.target.value)
                                      }
                                    />
                                  </label>
                                ))}
                                <div className="item-actions">
                                  <button
                                    type="button"
                                    className="btn primary small"
                                    onClick={() => saveItemChanges(item.id)}
                                    disabled={itemActionLoading}
                                  >
                                    Shrani
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={cancelEditing}
                                    disabled={itemActionLoading}
                                  >
                                    Prekliči
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="item-line">
                                  <span className="term">
                                    {item.solution ? item.solution.join(' · ') : '–'}
                                  </span>
                                  <span className="translation">{item.translation}</span>
                                </div>
                                <div className="item-actions">
                                  <button
                                    type="button"
                                    className="btn secondary small"
                                    onClick={() => startEditingItem(item)}
                                  >
                                    Uredi
                                  </button>
                                  <button
                                    type="button"
                                    className="btn warning small"
                                    onClick={() => deleteItem(item.id)}
                                    disabled={itemActionLoading}
                                  >
                                    Izbriši
                                  </button>
                                </div>
                              </>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {cycle && (
        <div className="modal-backdrop question-backdrop">
          <div className="modal question-modal">
            <div className="modal-header">
              <h3>
                Cikel #{cycle.cycle_number} ({cycle.mode})
              </h3>
              <button type="button" className="close-modal" onClick={cancelCycle}>
                ×
              </button>
            </div>
            <div className="modal-body">{renderQuestion()}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
