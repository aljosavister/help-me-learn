import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://127.0.0.1:8000'
const ADAPTIVE_AFTER_CYCLES = 5
const MIN_ATTEMPTS_FOR_ADAPTIVE = 25
const HIGH_ACCURACY_THRESHOLD = 0.88
const NUMBER_MAX_LIMIT = 1000000
const NUMBER_DEFAULT_MAX = 1000
const NUMBER_DEFAULT_CYCLE_SIZE = 20
const NUMBER_COMPONENTS = [
  { key: 'basic', label: 'Osnove 0–12' },
  { key: 'teens', label: 'Najstnice 13–19' },
  { key: 'tens', label: 'Desetice (20, 30, …, 90)' },
  { key: 'composite_tens', label: 'Sestavljene 21–99' },
  { key: 'hundreds', label: 'Stotice (100, 200, …, 900)' },
  { key: 'composite_hundreds', label: 'Sestavljene 101–999' },
  { key: 'thousands', label: 'Tisočice (1000, 2000, …)' },
  { key: 'composite_thousands', label: 'Sestavljene 1001+' },
]
const NUMBER_COMPONENTS_STORAGE_KEY = 'numberComponents'
const NUMBER_COMPONENTS_TOGGLE_KEY = 'numberComponentsEnabled'
const NUMBER_MAX_STORAGE_KEY = 'numberMax'
const NUMBER_CYCLE_SIZE_STORAGE_KEY = 'numberCycleSize'
const FAMILY_LEVELS = [
  { key: 'A1', label: 'A1 (osnove)' },
  { key: 'A2', label: 'A2 (razširjeno)' },
]
const FAMILY_CASES = [
  { key: 'nominative', label: 'Nominativ' },
  { key: 'accusative', label: 'Akuzativ' },
  { key: 'dative', label: 'Dativ' },
]
const FAMILY_MODES = [
  { key: 'noun', label: 'Samostalniki' },
  { key: 'phrase', label: 'Fraze (moj/tvoj/...)' },
]
const FAMILY_LEVELS_STORAGE_KEY = 'familyLevels'
const FAMILY_CASES_STORAGE_KEY = 'familyCases'
const FAMILY_MODES_STORAGE_KEY = 'familyModes'
const FAMILY_INCLUDE_PLURAL_KEY = 'familyIncludePlural'

const normalizeText = (text, { allowUmlautFallback = false, collapseSpaces = true } = {}) => {
  let cleaned = text.trim().toLowerCase().replace(/ß/g, 'ss')
  if (collapseSpaces) {
    cleaned = cleaned.replace(/\s+/g, ' ')
  }
  if (allowUmlautFallback) {
    cleaned = cleaned.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  }
  return cleaned
}

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
  const [numberMax, setNumberMax] = useState(String(NUMBER_DEFAULT_MAX))
  const [numberCycleSize, setNumberCycleSize] = useState(String(NUMBER_DEFAULT_CYCLE_SIZE))
  const [useNumberComponents, setUseNumberComponents] = useState(false)
  const [selectedNumberComponents, setSelectedNumberComponents] = useState(
    NUMBER_COMPONENTS.map((component) => component.key),
  )
  const [familyLevels, setFamilyLevels] = useState(['A1'])
  const [familyCases, setFamilyCases] = useState(['nominative'])
  const [familyModes, setFamilyModes] = useState(['noun', 'phrase'])
  const [familyIncludePlural, setFamilyIncludePlural] = useState(true)
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
  const [awaitingAdvance, setAwaitingAdvance] = useState(false)
  const [newItem, setNewItem] = useState({ translation: '', forms: [] })
  const [showResultsModal, setShowResultsModal] = useState(false)
  const [resultsItems, setResultsItems] = useState([])
  const [loadingResults, setLoadingResults] = useState(false)
  const [resultsWordType, setResultsWordType] = useState(null)
  const [listFilter, setListFilter] = useState('')
  const [resultsFilter, setResultsFilter] = useState('')
  const firstInputRef = useRef(null)
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
    if (!familyLevels.includes('A2')) {
      if (familyCases.length !== 1 || familyCases[0] !== 'nominative') {
        setFamilyCases(['nominative'])
      }
      return
    }
    if (familyCases.length === 0) {
      setFamilyCases(['nominative'])
    }
  }, [familyLevels, familyCases])

  useEffect(() => {
    try {
      const storedEnabled = localStorage.getItem(NUMBER_COMPONENTS_TOGGLE_KEY)
      if (storedEnabled !== null) {
        setUseNumberComponents(storedEnabled === 'true')
      }
      const storedComponents = localStorage.getItem(NUMBER_COMPONENTS_STORAGE_KEY)
      if (storedComponents) {
        const parsed = JSON.parse(storedComponents)
        if (Array.isArray(parsed)) {
          const allowed = new Set(NUMBER_COMPONENTS.map((component) => component.key))
          const filtered = parsed.filter((item) => allowed.has(item))
          setSelectedNumberComponents(filtered)
        }
      }
      const storedMax = localStorage.getItem(NUMBER_MAX_STORAGE_KEY)
      if (storedMax !== null) {
        setNumberMax(storedMax)
      }
      const storedCycleSize = localStorage.getItem(NUMBER_CYCLE_SIZE_STORAGE_KEY)
      if (storedCycleSize !== null) {
        setNumberCycleSize(storedCycleSize)
      }
      const storedFamilyLevels = localStorage.getItem(FAMILY_LEVELS_STORAGE_KEY)
      if (storedFamilyLevels) {
        const parsedLevels = JSON.parse(storedFamilyLevels)
        if (Array.isArray(parsedLevels)) {
          const allowed = new Set(FAMILY_LEVELS.map((level) => level.key))
          const filtered = parsedLevels.filter((item) => allowed.has(item))
          if (filtered.length) {
            setFamilyLevels(filtered)
          }
        }
      }
      const storedFamilyCases = localStorage.getItem(FAMILY_CASES_STORAGE_KEY)
      if (storedFamilyCases) {
        const parsedCases = JSON.parse(storedFamilyCases)
        if (Array.isArray(parsedCases)) {
          const allowed = new Set(FAMILY_CASES.map((item) => item.key))
          const filtered = parsedCases.filter((item) => allowed.has(item))
          if (filtered.length) {
            setFamilyCases(filtered)
          }
        }
      }
      const storedFamilyModes = localStorage.getItem(FAMILY_MODES_STORAGE_KEY)
      if (storedFamilyModes) {
        const parsedModes = JSON.parse(storedFamilyModes)
        if (Array.isArray(parsedModes)) {
          const allowed = new Set(FAMILY_MODES.map((item) => item.key))
          const filtered = parsedModes.filter((item) => allowed.has(item))
          if (filtered.length) {
            setFamilyModes(filtered)
          }
        }
      }
      const storedIncludePlural = localStorage.getItem(FAMILY_INCLUDE_PLURAL_KEY)
      if (storedIncludePlural !== null) {
        setFamilyIncludePlural(storedIncludePlural === 'true')
      }
    } catch (err) {
      console.error('Failed to load number components from storage', err)
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(NUMBER_COMPONENTS_TOGGLE_KEY, String(useNumberComponents))
      localStorage.setItem(
        NUMBER_COMPONENTS_STORAGE_KEY,
        JSON.stringify(selectedNumberComponents),
      )
      localStorage.setItem(NUMBER_MAX_STORAGE_KEY, numberMax)
      localStorage.setItem(NUMBER_CYCLE_SIZE_STORAGE_KEY, numberCycleSize)
      localStorage.setItem(FAMILY_LEVELS_STORAGE_KEY, JSON.stringify(familyLevels))
      localStorage.setItem(FAMILY_CASES_STORAGE_KEY, JSON.stringify(familyCases))
      localStorage.setItem(FAMILY_MODES_STORAGE_KEY, JSON.stringify(familyModes))
      localStorage.setItem(FAMILY_INCLUDE_PLURAL_KEY, String(familyIncludePlural))
    } catch (err) {
      console.error('Failed to save number components to storage', err)
    }
  }, [
    useNumberComponents,
    selectedNumberComponents,
    numberMax,
    numberCycleSize,
    familyLevels,
    familyCases,
    familyModes,
    familyIncludePlural,
  ])

  useEffect(() => {
    if (currentQuestion) {
      setAnswers(emptyAnswers(currentQuestion.labels))
      setQuestionStage('idle')
      setEvaluation(null)
      setSolutionVisible(false)
      setError('')
    }
  }, [currentQuestion])

  useEffect(() => {
    if (questionStage === 'idle' && firstInputRef.current) {
      firstInputRef.current.focus()
    }
  }, [questionStage, currentQuestion])

  const loadStats = async (wordType) => {
    if (!selectedUser) return
    try {
      const data = await apiFetch(`/users/${selectedUser.id}/stats?word_type=${wordType}`)
      setStats(data)
      return data
    } catch (err) {
      setError(err.message)
    }
    return null
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
    setAwaitingAdvance(false)
  }

  const toggleModuleItems = async (wordType) => {
    if (wordType === 'number' || wordType === 'family') return
    if (moduleItemsType === wordType) {
      setModuleItemsType(null)
      setModuleItems([])
      cancelEditing()
      setNewItem({ translation: '', forms: [] })
      return
    }
    setIsLoadingItems(true)
    setError('')
    try {
      const data = await apiFetch(`/items?word_type=${wordType}&include_solution=true`)
      setModuleItemsType(wordType)
      setModuleItems(data)
      cancelEditing()
      setNewItem({
        translation: '',
        forms: wordType === 'noun' ? [''] : ['', '', '', ''],
      })
      setListFilter('')
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoadingItems(false)
    }
  }

  const handleStartCycle = async () => {
    if (!selectedUser || !selectedModule) return
    let maxNumberPayload = null
    let cycleSizePayload = null
    let numberComponentsPayload = null
    let familyLevelsPayload = null
    let familyCasesPayload = null
    let familyModesPayload = null
    let familyIncludePluralPayload = null
    if (selectedModule === 'number') {
      const trimmedMax = numberMax.trim()
      if (!trimmedMax) {
        setError('Vnesi največjo številko.')
        return
      }
      const parsed = Number(trimmedMax)
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError('Vnesi celo število ≥ 0 za največjo številko.')
        return
      }
      if (parsed > NUMBER_MAX_LIMIT) {
        setError(`Največja številka mora biti ≤ ${NUMBER_MAX_LIMIT}.`)
        return
      }
      maxNumberPayload = parsed
      const trimmedSize = numberCycleSize.trim()
      if (!trimmedSize) {
        setError('Vnesi velikost cikla.')
        return
      }
      const sizeParsed = Number(trimmedSize)
      if (!Number.isInteger(sizeParsed) || sizeParsed < 1) {
        setError('Velikost cikla mora biti celo število ≥ 1.')
        return
      }
      cycleSizePayload = sizeParsed
      if (useNumberComponents) {
        if (selectedNumberComponents.length === 0) {
          setError('Izberi vsaj eno komponento.')
          return
        }
        numberComponentsPayload = selectedNumberComponents
      }
    }
    if (selectedModule === 'family') {
      if (familyLevels.length === 0) {
        setError('Izberi vsaj eno stopnjo.')
        return
      }
      if (familyModes.length === 0) {
        setError('Izberi vsaj en način vadbe.')
        return
      }
      const effectiveCases = familyLevels.includes('A2') ? familyCases : ['nominative']
      if (familyModes.includes('phrase') && effectiveCases.length === 0) {
        setError('Izberi vsaj en sklon.')
        return
      }
      familyLevelsPayload = familyLevels
      familyModesPayload = familyModes
      familyCasesPayload = effectiveCases
      familyIncludePluralPayload = familyIncludePlural
    }
    setIsBusy(true)
    setError('')
    try {
      const body = {
        user_id: selectedUser.id,
        word_type: selectedModule,
        include_solutions: true,
      }
      if (maxNumberPayload !== null) {
        body.max_number = maxNumberPayload
      }
      if (cycleSizePayload !== null) {
        body.cycle_size = cycleSizePayload
      }
      if (numberComponentsPayload) {
        body.number_components = numberComponentsPayload
      }
      if (familyLevelsPayload) {
        body.family_levels = familyLevelsPayload
      }
      if (familyCasesPayload) {
        body.family_cases = familyCasesPayload
      }
      if (familyModesPayload) {
        body.family_modes = familyModesPayload
      }
      if (familyIncludePluralPayload !== null) {
        body.family_include_plural = familyIncludePluralPayload
      }
      const data = await apiFetch('/cycles', {
        method: 'POST',
        body,
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
    const isNumberModule = selectedModule === 'number'
    const allowUmlautFallback = selectedModule === 'number' || selectedModule === 'family'
    const collapseSpaces = !isNumberModule
    const normalizedAnswers = answers.map((value) =>
      normalizeText(value || '', { allowUmlautFallback, collapseSpaces }),
    )
    const normalizedSolution = currentQuestion.solution.map((value) =>
      normalizeText(value || '', { allowUmlautFallback, collapseSpaces }),
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
    setAwaitingAdvance(true)
  }

  const handleValidateAnswers = async () => {
    if (!currentQuestion) return
    const isCorrect = answersMatchSolution()
    if (isCorrect) {
      setEvaluation({ correct: true, message: 'Odlično! Odgovor je pravilen.' })
      await recordAttempt(false, answers)
      setQuestionStage('final')
      setAwaitingAdvance(true)
      setRetryItem(null)
    } else {
      setSolutionVisible(true)
      setEvaluation({
        correct: false,
        message: 'Odgovor ni pravilen.',
      })
      setRetryItem(currentQuestion)
      await recordAttempt(true, answers)
      setQuestionStage('final')
      setAwaitingAdvance(true)
    }
  }

  const handleAdvance = async () => {
    if (!cycle) return
    setAwaitingAdvance(false)
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
      setQuestionStage('idle')
      setEvaluation(null)
      setSolutionVisible(false)
      setAnswers(emptyAnswers(items[nextIndex].labels))
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

  const handleNewFormChange = (index, value) => {
    setNewItem((prev) => {
      const copy = [...prev.forms]
      copy[index] = value
      return { ...prev, forms: copy }
    })
  }

  const clearNumberComponents = () => {
    setSelectedNumberComponents([])
  }

  const selectAllNumberComponents = () => {
    setSelectedNumberComponents(NUMBER_COMPONENTS.map((component) => component.key))
  }

  const toggleNumberComponent = (key) => {
    setSelectedNumberComponents((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key)
      }
      return [...prev, key]
    })
  }

  const toggleFamilyLevel = (key) => {
    setFamilyLevels((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key)
      }
      return [...prev, key]
    })
  }

  const toggleFamilyCase = (key) => {
    if (key !== 'nominative' && !familyLevels.includes('A2')) return
    setFamilyCases((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key)
      }
      return [...prev, key]
    })
  }

  const toggleFamilyMode = (key) => {
    setFamilyModes((prev) => {
      if (prev.includes(key)) {
        return prev.filter((item) => item !== key)
      }
      return [...prev, key]
    })
  }

  const handleCreateItem = async () => {
    if (!moduleItemsType) return
    setItemActionLoading(true)
    setError('')
    try {
      const created = await apiFetch('/items', {
        method: 'POST',
        body: {
          type: moduleItemsType,
          translation: newItem.translation,
          solution: newItem.forms,
        },
      })
      setModuleItems((prev) => [created, ...prev])
      await refreshModules()
      setNewItem({
        translation: '',
        forms: moduleItemsType === 'noun' ? [''] : ['', '', '', ''],
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setItemActionLoading(false)
    }
  }

  const openResultsModal = async (wordType) => {
    if (!selectedUser) return
    let maxNumberParam = null
    let familyQuery = null
    if (wordType === 'number') {
      const trimmed = numberMax.trim()
      if (!trimmed) {
        setError('Vnesi največjo številko.')
        return
      }
      const parsed = Number(trimmed)
      if (!Number.isInteger(parsed) || parsed < 0) {
        setError('Vnesi celo število ≥ 0 za največjo številko.')
        return
      }
      if (parsed > NUMBER_MAX_LIMIT) {
        setError(`Največja številka mora biti ≤ ${NUMBER_MAX_LIMIT}.`)
        return
      }
      maxNumberParam = parsed
    }
    if (wordType === 'family') {
      if (familyLevels.length === 0) {
        setError('Izberi vsaj eno stopnjo.')
        return
      }
      if (familyModes.length === 0) {
        setError('Izberi vsaj en način vadbe.')
        return
      }
      const effectiveCases = familyLevels.includes('A2') ? familyCases : ['nominative']
      if (familyModes.includes('phrase') && effectiveCases.length === 0) {
        setError('Izberi vsaj en sklon.')
        return
      }
      const params = new URLSearchParams({
        include_solution: 'true',
        user_id: String(selectedUser.id),
        include_plural: String(familyIncludePlural),
      })
      familyLevels.forEach((level) => params.append('levels', level))
      effectiveCases.forEach((item) => params.append('cases', item))
      familyModes.forEach((mode) => params.append('modes', mode))
      familyQuery = params.toString()
    }
    setShowResultsModal(true)
    setResultsWordType(wordType)
    setLoadingResults(true)
    setResultsItems([])
    setError('')
    try {
      const endpoint =
        wordType === 'number'
          ? `/numbers/results?include_solution=true&user_id=${selectedUser.id}&max_number=${maxNumberParam}`
          : wordType === 'family'
            ? `/family/results?${familyQuery}`
          : `/items?word_type=${wordType}&include_solution=true&user_id=${selectedUser.id}`
      const data = await apiFetch(endpoint)
      const sorted = [...data].sort((a, b) => {
        const aAttempts = a.attempts || 0
        const bAttempts = b.attempts || 0
        const aAccuracy = aAttempts ? (a.correct || 0) / aAttempts : 1
        const bAccuracy = bAttempts ? (b.correct || 0) / bAttempts : 1
        if (aAccuracy !== bAccuracy) return aAccuracy - bAccuracy // nižje najprej
        return bAttempts - aAttempts // več poskusov najprej
      })
      setResultsItems(sorted)
      setResultsFilter('')
    } catch (err) {
      setError(err.message)
    } finally {
      setLoadingResults(false)
    }
  }

  const nextCycleModeLabel = () => {
    if (!stats) return ''
    const cycleIndex = (stats.cycle_count || 0) + 1
    const attempts = stats.attempts || 0
    const accuracy = attempts ? (stats.correct || 0) / attempts : 0
    const adaptive =
      cycleIndex > ADAPTIVE_AFTER_CYCLES ||
      (attempts >= MIN_ATTEMPTS_FOR_ADAPTIVE && accuracy >= HIGH_ACCURACY_THRESHOLD)
    return adaptive ? 'Naslednji cikel: adaptivni način' : 'Naslednji cikel: naključni način'
  }

  const nextCycleModeExplanation = () => {
    return `Adaptivni način se vklopi po ${ADAPTIVE_AFTER_CYCLES}+ ciklih ali pri vsaj ${MIN_ATTEMPTS_FOR_ADAPTIVE} poskusih in uspešnosti ≥ ${Math.round(
      HIGH_ACCURACY_THRESHOLD * 100,
    )}%.`
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

  const filteredResultsItems = useMemo(() => {
    if (!resultsFilter.trim()) return resultsItems
    const q = resultsFilter.toLowerCase()
    return resultsItems.filter((item) => {
      const haystack = [item.translation || '', ...(item.solution || [])]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [resultsItems, resultsFilter])

  const hasWrongResults = useMemo(
    () => filteredResultsItems.some((item) => (item.wrong || 0) > 0),
    [filteredResultsItems],
  )

  const startReviewCycle = async () => {
    if (!selectedUser || !resultsWordType) return
    setError('')
    const wrongItems = filteredResultsItems.filter((item) => (item.wrong || 0) > 0)
    if (wrongItems.length === 0) {
      setError('Ni napačnih odgovorov za ponovitev.')
      return
    }
    let limit = null
    if (resultsWordType === 'number') {
      const trimmedSize = numberCycleSize.trim()
      if (!trimmedSize) {
        setError('Vnesi velikost cikla.')
        return
      }
      const sizeParsed = Number(trimmedSize)
      if (!Number.isInteger(sizeParsed) || sizeParsed < 1) {
        setError('Velikost cikla mora biti celo število ≥ 1.')
        return
      }
      limit = sizeParsed
    }
    const sorted = [...wrongItems].sort((a, b) => {
      const aAttempts = a.attempts || 0
      const bAttempts = b.attempts || 0
      const aAccuracy = aAttempts ? (a.correct || 0) / aAttempts : 1
      const bAccuracy = bAttempts ? (b.correct || 0) / bAttempts : 1
      if (aAccuracy !== bAccuracy) return aAccuracy - bAccuracy
      return bAttempts - aAttempts
    })
    const selection = limit ? sorted.slice(0, limit) : sorted
    const statsData = await loadStats(resultsWordType)
    const cycleIndex = (statsData?.cycle_count || 0) + 1
    const items = selection.map((item) => ({
      id: item.id,
      translation: item.translation,
      labels: item.labels || (resultsWordType === 'number' ? ['Zapis po nemško'] : []),
      attempts: item.attempts ?? 0,
      accuracy: item.attempts ? (item.correct || 0) / item.attempts : 0,
      streak: item.streak ?? 0,
      difficulty: 0,
      solution: item.solution || [],
    }))
    setSelectedModule(resultsWordType)
    setCycle({
      cycle_number: cycleIndex,
      adaptive: false,
      mode: 'ponovitev napačnih',
      total_items: items.length,
      items,
    })
    setCurrentIndex(0)
    setAnswers(emptyAnswers(items[0]?.labels))
    setQuestionStage('idle')
    setEvaluation(null)
    setSolutionVisible(false)
    setRetryItem(null)
    setAwaitingAdvance(false)
    setShowResultsModal(false)
  }

  const renderQuestion = () => {
    if (!currentQuestion) {
      return (
        <div className="empty-state">
          <p>Izberi modul in zaženi cikel, da dobiš vprašanja.</p>
        </div>
      )
    }
    const isNumberModule = selectedModule === 'number'
    const moduleLabel =
      selectedModule === 'noun'
        ? 'Samostalnik'
        : selectedModule === 'verb'
          ? 'Nepravilni glagol'
          : selectedModule === 'number'
            ? 'Število'
            : 'Družina'

    return (
      <div className="question-card">
        <div className="question-meta">
          <span>{currentCycleInfo}</span>
          <span>
            Vprašanje {currentIndex + 1}/{cycle.items.length}
          </span>
          <span>{moduleLabel}</span>
        </div>
        <div className="translation">
          <p>{isNumberModule ? 'Število:' : 'Pomen v slovenščini:'}</p>
          <h3>{currentQuestion.translation}</h3>
        </div>
        <div className="inputs">
          {currentQuestion.labels.map((label, index) => (
            <label key={label} className="input-row">
              <span>{label}</span>
              <input
                type="text"
                ref={index === 0 ? firstInputRef : null}
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
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    if (questionStage === 'idle') {
                      handleValidateAnswers()
                    } else if (questionStage === 'final' || awaitingAdvance) {
                      handleAdvance()
                    }
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
        </div>
        {evaluation && (
          <div className={`status ${evaluation.correct ? 'success' : 'danger'}`}>
            {evaluation.message}
          </div>
        )}
        {solutionVisible && currentQuestion.solution && (
          <div
            className={`solution-panel ${
              evaluation && !evaluation.correct ? 'solution-highlight' : ''
            }`}
          >
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
        {questionStage === 'final' && (
          <div className="actions">
            <button className="btn primary" onClick={handleAdvance} disabled={isBusy}>
              {isLastQuestion ? 'Zaključi cikel [Enter]' : 'Naslednje vprašanje [Enter]'}
            </button>
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
          <h1>Samostalniki, nepravilni glagoli, števila & družina</h1>
        </div>
        <div className="header-actions">
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
            {modules.map((module) => {
              const isNumberModule = module.type === 'number'
              const isFamilyModule = module.type === 'family'
              const isSpecialModule = isNumberModule || isFamilyModule
              return (
                <div key={module.type} className="module-row">
                  <button
                    className={`pill ${selectedModule === module.type ? 'active' : ''}`}
                    onClick={() => setSelectedModule(module.type)}
                  >
                    <strong>
                      {module.label}
                      {!isSpecialModule && ` (${module.count})`}
                    </strong>
                  </button>
                  {!isSpecialModule && (
                    <>
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
                        Uredi seznam
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => openResultsModal(module.type)}
                        disabled={!selectedUser}
                      >
                        Rezultati
                      </button>
                    </>
                  )}
                  {isSpecialModule && (
                    <>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => openResultsModal(module.type)}
                        disabled={!selectedUser}
                      >
                        Rezultati
                      </button>
                      <span className="hint">
                        {isNumberModule
                          ? 'Razpon določiš ob zagonu.'
                          : 'Filtre določiš ob zagonu.'}
                      </span>
                    </>
                  )}
                </div>
              )
            })}
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
          {selectedModule === 'number' && (
            <div className="number-config">
              <label>
                <span>Največja številka</span>
                <input
                  type="number"
                  min="0"
                  max={NUMBER_MAX_LIMIT}
                  value={numberMax}
                  onChange={(event) => setNumberMax(event.target.value)}
                />
              </label>
              <label>
                <span>Velikost cikla</span>
                <input
                  type="number"
                  min="1"
                  value={numberCycleSize}
                  onChange={(event) => setNumberCycleSize(event.target.value)}
                />
              </label>
              <div className="component-toggle">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={useNumberComponents}
                    onChange={(event) => setUseNumberComponents(event.target.checked)}
                  />
                  <span>Učenje po komponentah</span>
                </label>
                <span className="hint">
                  Izberi skupine števil, ki jih želiš vaditi (upošteva največjo številko).
                </span>
              </div>
              {useNumberComponents && (
                <>
                  <div className="component-actions">
                    <button
                      type="button"
                      className="btn secondary small"
                      onClick={selectAllNumberComponents}
                      disabled={selectedNumberComponents.length === NUMBER_COMPONENTS.length}
                    >
                      Izberi vse
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={clearNumberComponents}
                      disabled={selectedNumberComponents.length === 0}
                    >
                      Počisti vse
                    </button>
                  </div>
                  <div className="components-grid">
                    {NUMBER_COMPONENTS.map((component) => (
                      <label key={component.key} className="component-option">
                        <input
                          type="checkbox"
                          checked={selectedNumberComponents.includes(component.key)}
                          onChange={() => toggleNumberComponent(component.key)}
                        />
                        <span>{component.label}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
              <p className="hint">
                Primer: 1000 pomeni, da vadiš števila od 0 do 1000. Velikost cikla določa število
                vprašanj v enem zagonu.
              </p>
            </div>
          )}
          {selectedModule === 'family' && (
            <div className="family-config">
              <div className="family-section">
                <p className="section-title">Stopnja</p>
                <div className="family-options">
                  {FAMILY_LEVELS.map((level) => (
                    <label key={level.key} className="family-option">
                      <input
                        type="checkbox"
                        checked={familyLevels.includes(level.key)}
                        onChange={() => toggleFamilyLevel(level.key)}
                      />
                      <span>{level.label}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="family-section">
                <p className="section-title">Način vadbe</p>
                <div className="family-options">
                  {FAMILY_MODES.map((mode) => (
                    <label key={mode.key} className="family-option">
                      <input
                        type="checkbox"
                        checked={familyModes.includes(mode.key)}
                        onChange={() => toggleFamilyMode(mode.key)}
                      />
                      <span>{mode.label}</span>
                    </label>
                  ))}
                  <label className="family-option">
                    <input
                      type="checkbox"
                      checked={familyIncludePlural}
                      onChange={(event) => setFamilyIncludePlural(event.target.checked)}
                      disabled={!familyModes.includes('noun')}
                    />
                    <span>Vključi plural pri samostalnikih</span>
                  </label>
                </div>
              </div>
              <div className="family-section">
                <p className="section-title">Skloni</p>
                <div className="family-options">
                  {FAMILY_CASES.map((item) => {
                    const disabled = item.key !== 'nominative' && !familyLevels.includes('A2')
                    return (
                      <label key={item.key} className="family-option">
                        <input
                          type="checkbox"
                          checked={familyCases.includes(item.key)}
                          onChange={() => toggleFamilyCase(item.key)}
                          disabled={disabled}
                        />
                        <span>{item.label}</span>
                      </label>
                    )
                  })}
                </div>
                {!familyLevels.includes('A2') && (
                  <span className="hint">Akuzativ in dativ se odpreta z A2.</span>
                )}
              </div>
            </div>
          )}
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
              <h3>
                Statistika (
                {stats.word_type === 'noun'
                  ? 'samostalniki'
                  : stats.word_type === 'verb'
                    ? 'glagoli'
                    : stats.word_type === 'number'
                      ? 'števila'
                      : 'družina'}
                )
              </h3>
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
                <li>
                  {nextCycleModeLabel()}
                  <br />
                  <span className="hint">{nextCycleModeExplanation()}</span>
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
                <div className="create-form">
                  <h4>Dodaj nov vnos</h4>
                  <input
                    type="text"
                    placeholder="Filter po geslih/prevodih"
                    value={listFilter}
                    onChange={(e) => setListFilter(e.target.value)}
                  />
                  <label>
                    <span>Prevod</span>
                    <input
                      type="text"
                      value={newItem.translation}
                      onChange={(event) =>
                        setNewItem((prev) => ({ ...prev, translation: event.target.value }))
                      }
                    />
                  </label>
                  {moduleItemsType === 'noun'
                    ? ['Člen + samostalnik'].map((label, index) => (
                        <label key={label}>
                          <span>{label}</span>
                          <input
                            type="text"
                            value={newItem.forms[index] ?? ''}
                            onChange={(event) => handleNewFormChange(index, event.target.value)}
                          />
                        </label>
                      ))
                    : ['Infinitiv', '3. oseba ednine', 'Preterit', 'Perfekt'].map(
                        (label, index) => (
                          <label key={label}>
                            <span>{label}</span>
                            <input
                              type="text"
                              value={newItem.forms[index] ?? ''}
                              onChange={(event) => handleNewFormChange(index, event.target.value)}
                            />
                          </label>
                        ),
                      )}
                  <div className="item-actions">
                    <button
                      type="button"
                      className="btn primary small"
                      onClick={handleCreateItem}
                      disabled={itemActionLoading || !moduleItemsType}
                    >
                      Dodaj
                    </button>
                  </div>
                </div>
                {isLoadingItems ? (
                  <p>Nalaganje ...</p>
                ) : moduleItems.length === 0 ? (
                  <p>Trenutno ni zapisov.</p>
                ) : (
                  <ul className="items-list">
                    {moduleItems
                      .filter((item) => {
                        if (!listFilter.trim()) return true
                        const q = listFilter.toLowerCase()
                        const haystack = [
                          item.translation || '',
                          ...(item.solution || []),
                        ]
                          .join(' ')
                          .toLowerCase()
                        return haystack.includes(q)
                      })
                      .map((item) => {
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
      {showResultsModal && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target.classList.contains('modal-backdrop')) {
              setShowResultsModal(false)
            }
          }}
        >
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>
                Rezultati (
                {resultsWordType === 'noun'
                  ? 'Samostalniki'
                  : resultsWordType === 'verb'
                    ? 'Nepravilni glagoli'
                    : resultsWordType === 'number'
                      ? 'Števila'
                      : 'Družina'}
                )
              </h3>
              <button type="button" className="close-modal" onClick={() => setShowResultsModal(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                placeholder="Filter po geslih, prevodih ali številih"
                value={resultsFilter}
                onChange={(e) => setResultsFilter(e.target.value)}
                className="filter-input"
              />
              <div className="results-actions">
                <button
                  type="button"
                  className="btn warning small"
                  onClick={startReviewCycle}
                  disabled={loadingResults || !hasWrongResults}
                >
                  Ponovi napačne
                </button>
              </div>
              {loadingResults ? (
                <p>Nalaganje ...</p>
              ) : filteredResultsItems.length === 0 ? (
                <p>Ni podatkov.</p>
              ) : (
                <ul className="items-list">
                  {filteredResultsItems.map((item) => {
                    const isNumberResult = resultsWordType === 'number'
                    const term = isNumberResult
                      ? item.translation
                      : item.solution
                        ? item.solution.join(' · ')
                        : '–'
                    const translation = isNumberResult
                      ? item.solution
                        ? item.solution.join(' · ')
                        : '–'
                      : item.translation
                    return (
                      <li key={item.id}>
                        <div className="item-line">
                          <span className="term">{term}</span>
                          <span className="translation">{translation}</span>
                        </div>
                        <div className="item-stats">
                          <span>Poskusi: {item.attempts ?? 0}</span>
                          <span>Pravilni: {item.correct ?? 0}</span>
                          <span>Napačni: {item.wrong ?? 0}</span>
                          <span>Pogledi: {item.reveals ?? 0}</span>
                        </div>
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
  )
}

export default App
