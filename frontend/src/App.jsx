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
const COLLECTION_MODULES = [
  { key: 'noun', label: 'Samostalniki' },
  { key: 'verb', label: 'Nepravilni glagoli' },
  { key: 'number', label: 'Števila' },
  { key: 'family', label: 'Družina' },
]
const FAMILY_MODES = [
  { key: 'noun', label: 'Samostalniki' },
  { key: 'phrase', label: 'Fraze (moj/tvoj/...)' },
]
const FAMILY_LEVELS_STORAGE_KEY = 'familyLevels'
const FAMILY_CASES_STORAGE_KEY = 'familyCases'
const FAMILY_MODES_STORAGE_KEY = 'familyModes'
const FAMILY_INCLUDE_PLURAL_KEY = 'familyIncludePlural'
const ACTIVE_COLLECTION_STORAGE_KEY = 'activeCollectionVersionId'
const ANONYMOUS_USER = { id: 0, name: 'Anonimno', level: 0 }
const MODERATOR_LEVEL = 1
const ADMIN_LEVEL = 2
const USER_LEVEL_LABELS = {
  0: 'Uporabnik',
  1: 'Urednik',
  2: 'Admin',
}
const USER_LEVEL_OPTIONS = [
  { value: 0, label: 'Uporabnik' },
  { value: 1, label: 'Urednik' },
  { value: 2, label: 'Admin' },
]

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
  const [activeCollection, setActiveCollection] = useState(null)
  const [publicCollections, setPublicCollections] = useState([])
  const [ownerCollections, setOwnerCollections] = useState([])
  const [collectionCode, setCollectionCode] = useState('')
  const [collectionBusy, setCollectionBusy] = useState(false)
  const [newCollection, setNewCollection] = useState({ title: '', description: '' })
  const [versionForm, setVersionForm] = useState({
    collectionId: null,
    versionId: null,
    versionNumber: null,
    mode: 'create',
    title: '',
    description: '',
    visibility: 'draft',
    modules: COLLECTION_MODULES.map((module) => module.key),
    nounScope: 'all',
    verbScope: 'all',
    nounItems: [],
    verbItems: [],
    configSnapshot: null,
  })
  const [versionEdit, setVersionEdit] = useState({
    id: null,
    title: '',
    description: '',
  })
  const [collectionEdit, setCollectionEdit] = useState({
    id: null,
    title: '',
    description: '',
  })
  const [selectionModal, setSelectionModal] = useState({
    open: false,
    wordType: null,
    items: [],
    filter: '',
    loading: false,
  })
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
  const [infoMessage, setInfoMessage] = useState('')
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
  const [itemProposals, setItemProposals] = useState([])
  const [isLoadingProposals, setIsLoadingProposals] = useState(false)
  const [proposalActionLoading, setProposalActionLoading] = useState(false)
  const [isUpdatingUserLevel, setIsUpdatingUserLevel] = useState(false)
  const [proposalFilters, setProposalFilters] = useState({
    wordType: 'all',
    proposalType: 'all',
    proposerId: 'all',
    query: '',
  })
  const nounInputRef = useRef(null)
  const verbInputRef = useRef(null)

  const activeCollectionId = activeCollection?.versionId || null
  const isAnonymous = selectedUser?.id === ANONYMOUS_USER.id
  const userLevel = selectedUser?.level ?? 0
  const canEditItems = !activeCollectionId && !isAnonymous && Boolean(selectedUser)
  const canManageCollections = Boolean(selectedUser && !isAnonymous)
  const canReviewProposals = Boolean(selectedUser && !isAnonymous && userLevel >= MODERATOR_LEVEL)
  const canAssignLevels = Boolean(selectedUser && !isAnonymous && userLevel >= ADMIN_LEVEL)

  const refreshModules = useCallback(
    async (versionId = activeCollectionId) => {
      const path = versionId ? `/modules?collection_version_id=${versionId}` : '/modules'
      const moduleData = await apiFetch(path)
      setModules(moduleData)
    },
    [activeCollectionId],
  )

  const currentQuestion = cycle ? cycle.items[currentIndex] : null
  const isLastQuestion = cycle ? currentIndex === cycle.items.length - 1 : false

  const loadUsersAndModules = useCallback(async () => {
    setIsLoadingData(true)
    try {
      const modulePath = activeCollectionId
        ? `/modules?collection_version_id=${activeCollectionId}`
        : '/modules'
      const [userData, moduleData] = await Promise.all([
        apiFetch('/users'),
        apiFetch(modulePath),
      ])
      setUsers(userData)
      setModules(moduleData)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoadingData(false)
    }
  }, [activeCollectionId])

  const loadItemProposals = useCallback(async () => {
    if (!selectedUser || !canReviewProposals) {
      setItemProposals([])
      return
    }
    setIsLoadingProposals(true)
    setError('')
    try {
      const params = new URLSearchParams({
        status: 'pending',
        reviewer_user_id: String(selectedUser.id),
      })
      if (proposalFilters.wordType !== 'all') {
        params.set('word_type', proposalFilters.wordType)
      }
      if (proposalFilters.proposalType !== 'all') {
        params.set('proposal_type', proposalFilters.proposalType)
      }
      if (proposalFilters.proposerId !== 'all') {
        params.set('proposer_user_id', proposalFilters.proposerId)
      }
      if (proposalFilters.query.trim()) {
        params.set('query', proposalFilters.query.trim())
      }
      const data = await apiFetch(`/item-proposals?${params.toString()}`)
      setItemProposals(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setIsLoadingProposals(false)
    }
  }, [selectedUser, canReviewProposals, proposalFilters])

  const updateUserLevel = async (userId, level) => {
    if (!selectedUser) return
    setIsUpdatingUserLevel(true)
    setError('')
    try {
      const updated = await apiFetch(`/users/${userId}`, {
        method: 'PATCH',
        body: {
          requester_user_id: selectedUser.id,
          level,
        },
      })
      setUsers((prev) => prev.map((user) => (user.id === updated.id ? updated : user)))
      if (selectedUser.id === updated.id) {
        setSelectedUser(updated)
      }
      setInfoMessage('Nivo uporabnika posodobljen.')
    } catch (err) {
      setError(err.message)
    } finally {
      setIsUpdatingUserLevel(false)
    }
  }

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
    loadItemProposals()
  }, [loadItemProposals])

  const loadStoredSettings = useCallback(() => {
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
    loadStoredSettings()
  }, [loadStoredSettings])

  useEffect(() => {
    if (activeCollection) {
      return
    }
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
    activeCollection,
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

  useEffect(() => {
    if (selectedModule && !modules.some((module) => module.type === selectedModule)) {
      setSelectedModule(null)
    }
  }, [modules, selectedModule])

  const loadStats = async (wordType) => {
    if (!selectedUser) return
    try {
      const params = new URLSearchParams({ word_type: wordType })
      if (activeCollectionId) {
        params.set('collection_version_id', String(activeCollectionId))
      }
      const data = await apiFetch(`/users/${selectedUser.id}/stats?${params.toString()}`)
      setStats(data)
      return data
    } catch (err) {
      setError(err.message)
    }
    return null
  }

  const applyCollectionConfig = (config) => {
    if (!config || typeof config !== 'object') return
    const numberConfig = config.number || {}
    if (numberConfig.max_number !== undefined) {
      setNumberMax(String(numberConfig.max_number))
    }
    if (numberConfig.cycle_size !== undefined && numberConfig.cycle_size !== null) {
      setNumberCycleSize(String(numberConfig.cycle_size))
    }
    if (typeof numberConfig.use_components === 'boolean') {
      setUseNumberComponents(numberConfig.use_components)
    }
    if (Array.isArray(numberConfig.components)) {
      const allowed = new Set(NUMBER_COMPONENTS.map((component) => component.key))
      const filtered = numberConfig.components.filter((item) => allowed.has(item))
      if (filtered.length) {
        setSelectedNumberComponents(filtered)
      }
    } else if (numberConfig.use_components) {
      setSelectedNumberComponents(NUMBER_COMPONENTS.map((component) => component.key))
    }

    const familyConfig = config.family || {}
    if (Array.isArray(familyConfig.levels) && familyConfig.levels.length) {
      setFamilyLevels(familyConfig.levels)
    }
    if (Array.isArray(familyConfig.modes) && familyConfig.modes.length) {
      setFamilyModes(familyConfig.modes)
    }
    if (Array.isArray(familyConfig.cases) && familyConfig.cases.length) {
      setFamilyCases(familyConfig.cases)
    }
    if (typeof familyConfig.include_plural === 'boolean') {
      setFamilyIncludePlural(familyConfig.include_plural)
    }
  }

  const activateCollection = async (payload) => {
    const next = {
      collectionId: payload.collection_id,
      collectionTitle: payload.title,
      collectionDescription: payload.description,
      ownerName: payload.owner_name,
      versionId: payload.version_id,
      versionNumber: payload.version_number,
      versionTitle: payload.version_title,
      versionDescription: payload.version_description,
      accessCode: payload.access_code,
      visibility: payload.visibility,
      config: payload.config || {},
    }
    setActiveCollection(next)
    localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, JSON.stringify(next))
    applyCollectionConfig(next.config)
    await refreshModules(next.versionId)
    resetCycleState()
    setStats(null)
    setShowResultsModal(false)
    setResultsItems([])
    setResultsFilter('')
  }

  const activateOwnerVersion = async (collection, version) => {
    const next = {
      collectionId: collection.id,
      collectionTitle: collection.title,
      collectionDescription: collection.description,
      ownerName: selectedUser?.name || '',
      versionId: version.id,
      versionNumber: version.version_number,
      versionTitle: version.title,
      versionDescription: version.description,
      accessCode: version.access_code,
      visibility: version.visibility,
      config: version.config || {},
    }
    setActiveCollection(next)
    localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, JSON.stringify(next))
    applyCollectionConfig(next.config)
    await refreshModules(next.versionId)
    resetCycleState()
    setStats(null)
    setShowResultsModal(false)
    setResultsItems([])
    setResultsFilter('')
  }

  const clearActiveCollection = async () => {
    setActiveCollection(null)
    localStorage.removeItem(ACTIVE_COLLECTION_STORAGE_KEY)
    await refreshModules(null)
    loadStoredSettings()
    resetCycleState()
    setStats(null)
    setSelectedModule(null)
    setShowResultsModal(false)
    setResultsItems([])
    setResultsFilter('')
  }

  const loadPublicCollections = useCallback(async () => {
    try {
      const data = await apiFetch('/collections/public')
      setPublicCollections(data)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const loadOwnerCollections = useCallback(async (userId) => {
    try {
      const data = await apiFetch(`/collections/owner/${userId}`)
      setOwnerCollections(data)
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const handleResolveCollectionCode = async () => {
    if (!collectionCode.trim()) return
    setCollectionBusy(true)
    setError('')
    try {
      const data = await apiFetch(`/collections/code/${collectionCode.trim().toUpperCase()}`)
      await activateCollection(data)
      setCollectionCode('')
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const handleCreateCollection = async (event) => {
    event.preventDefault()
    if (!selectedUser || isAnonymous) return
    if (!newCollection.title.trim()) {
      setError('Vnesi naziv zbirke.')
      return
    }
    setCollectionBusy(true)
    setError('')
    try {
      await apiFetch('/collections', {
        method: 'POST',
        body: {
          owner_user_id: selectedUser.id,
          title: newCollection.title.trim(),
          description: newCollection.description.trim(),
        },
      })
      setNewCollection({ title: '', description: '' })
      await loadOwnerCollections(selectedUser.id)
      await loadPublicCollections()
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const openVersionForm = (collectionId) => {
    setVersionForm({
      collectionId,
      versionId: null,
      versionNumber: null,
      mode: 'create',
      title: '',
      description: '',
      visibility: 'draft',
      modules: COLLECTION_MODULES.map((module) => module.key),
      nounScope: 'all',
      verbScope: 'all',
      nounItems: [],
      verbItems: [],
      configSnapshot: null,
    })
  }

  const openEditVersionForm = async (collection, version) => {
    if (!selectedUser || isAnonymous) return
    setCollectionBusy(true)
    setError('')
    try {
      const versionData = await apiFetch(
        `/collections/versions/${version.id}?viewer_user_id=${selectedUser.id}`,
      )
      const itemsData = await apiFetch(
        `/collections/versions/${version.id}/items?owner_user_id=${selectedUser.id}`,
      )
      const config = versionData.config || {}
      setVersionForm({
        collectionId: collection.id,
        versionId: version.id,
        versionNumber: version.version_number,
        mode: 'edit',
        title: versionData.title || '',
        description: versionData.description || '',
        visibility: versionData.visibility || 'draft',
        modules: config.modules || COLLECTION_MODULES.map((module) => module.key),
        nounScope: config.noun?.scope || 'all',
        verbScope: config.verb?.scope || 'all',
        nounItems: itemsData.noun_item_ids || [],
        verbItems: itemsData.verb_item_ids || [],
        configSnapshot: config,
      })
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const openVersionMetaEdit = (version) => {
    setVersionEdit({
      id: version.id,
      title: version.title || '',
      description: version.description || '',
    })
  }

  const openCollectionMetaEdit = (collection) => {
    setCollectionEdit({
      id: collection.id,
      title: collection.title || '',
      description: collection.description || '',
    })
  }

  const cancelCollectionMetaEdit = () => {
    setCollectionEdit({ id: null, title: '', description: '' })
  }

  const saveCollectionMetaEdit = async () => {
    if (!selectedUser || isAnonymous || !collectionEdit.id) return
    setCollectionBusy(true)
    setError('')
    try {
      const updated = await apiFetch(`/collections/${collectionEdit.id}`, {
        method: 'PATCH',
        body: {
          owner_user_id: selectedUser.id,
          title: collectionEdit.title.trim(),
          description: collectionEdit.description.trim(),
        },
      })
      setActiveCollection((prev) => {
        if (!prev || prev.collectionId !== updated.id) return prev
        const next = {
          ...prev,
          collectionTitle: updated.title,
          collectionDescription: updated.description,
        }
        localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, JSON.stringify(next))
        return next
      })
      cancelCollectionMetaEdit()
      await loadOwnerCollections(selectedUser.id)
      await loadPublicCollections()
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const syncActiveCollectionVersion = (versionId, updates) => {
    const shouldApply = Boolean(
      updates?.config && activeCollection && activeCollection.versionId === versionId,
    )
    setActiveCollection((prev) => {
      if (!prev || prev.versionId !== versionId) return prev
      const next = { ...prev, ...updates }
      localStorage.setItem(ACTIVE_COLLECTION_STORAGE_KEY, JSON.stringify(next))
      return next
    })
    if (shouldApply) {
      applyCollectionConfig(updates.config)
      refreshModules(versionId)
      if (cycle) {
        resetCycleState()
        setStats(null)
        setInfoMessage('Cikel zaprt zaradi spremembe konfiguracije zbirke.')
      }
    }
  }

  const cancelVersionMetaEdit = () => {
    setVersionEdit({ id: null, title: '', description: '' })
  }

  const saveVersionMetaEdit = async () => {
    if (!selectedUser || isAnonymous || !versionEdit.id) return
    setCollectionBusy(true)
    setError('')
    try {
      await apiFetch(`/collections/versions/${versionEdit.id}`, {
        method: 'PATCH',
        body: {
          owner_user_id: selectedUser.id,
          title: versionEdit.title.trim(),
          description: versionEdit.description.trim(),
        },
      })
      syncActiveCollectionVersion(versionEdit.id, {
        versionTitle: versionEdit.title.trim(),
        versionDescription: versionEdit.description.trim(),
      })
      cancelVersionMetaEdit()
      await loadOwnerCollections(selectedUser.id)
      await loadPublicCollections()
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const handleQuickVisibilityChange = async (versionId, nextVisibility, currentVisibility) => {
    if (!selectedUser || isAnonymous) return
    if (nextVisibility === currentVisibility) return
    setCollectionBusy(true)
    setError('')
    try {
      await apiFetch(`/collections/versions/${versionId}`, {
        method: 'PATCH',
        body: {
          owner_user_id: selectedUser.id,
          visibility: nextVisibility,
        },
      })
      syncActiveCollectionVersion(versionId, { visibility: nextVisibility })
      await loadOwnerCollections(selectedUser.id)
      await loadPublicCollections()
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  const closeVersionForm = () => {
    setVersionForm((prev) => ({
      ...prev,
      collectionId: null,
      versionId: null,
      versionNumber: null,
      mode: 'create',
    }))
  }

  const toggleVersionModule = (key) => {
    setVersionForm((prev) => {
      const exists = prev.modules.includes(key)
      const modules = exists ? prev.modules.filter((item) => item !== key) : [...prev.modules, key]
      const next = { ...prev, modules }
      if (!modules.includes('noun')) {
        next.nounScope = 'all'
        next.nounItems = []
      }
      if (!modules.includes('verb')) {
        next.verbScope = 'all'
        next.verbItems = []
      }
      return next
    })
  }

  const buildCollectionConfig = () => {
    const modules = versionForm.modules
    if (!modules.length) {
      setError('Izberi vsaj en modul.')
      return null
    }
    const config = { modules }
    if (modules.includes('noun')) {
      if (versionForm.nounScope === 'subset' && versionForm.nounItems.length === 0) {
        setError('Izberi vsaj en samostalnik.')
        return null
      }
      config.noun = { scope: versionForm.nounScope }
    }
    if (modules.includes('verb')) {
      if (versionForm.verbScope === 'subset' && versionForm.verbItems.length === 0) {
        setError('Izberi vsaj en glagol.')
        return null
      }
      config.verb = { scope: versionForm.verbScope }
    }
    if (modules.includes('number')) {
      if (versionForm.mode === 'edit' && versionForm.configSnapshot?.number) {
        config.number = versionForm.configSnapshot.number
      } else {
      const trimmedMax = numberMax.trim()
      if (!trimmedMax) {
        setError('Vnesi največjo številko za števila.')
        return null
      }
      const parsed = Number(trimmedMax)
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > NUMBER_MAX_LIMIT) {
        setError(`Največja številka mora biti celo število ≤ ${NUMBER_MAX_LIMIT}.`)
        return null
      }
      const trimmedSize = numberCycleSize.trim()
      if (!trimmedSize) {
        setError('Vnesi velikost cikla za števila.')
        return null
      }
      const sizeParsed = Number(trimmedSize)
      if (!Number.isInteger(sizeParsed) || sizeParsed < 1) {
        setError('Velikost cikla mora biti celo število ≥ 1.')
        return null
      }
      if (useNumberComponents && selectedNumberComponents.length === 0) {
        setError('Izberi vsaj eno komponento števil.')
        return null
      }
      config.number = {
        max_number: parsed,
        cycle_size: sizeParsed,
        use_components: useNumberComponents,
        components: useNumberComponents ? selectedNumberComponents : null,
      }
      }
    }
    if (modules.includes('family')) {
      if (versionForm.mode === 'edit' && versionForm.configSnapshot?.family) {
        config.family = versionForm.configSnapshot.family
      } else {
      if (familyLevels.length === 0) {
        setError('Izberi vsaj eno stopnjo za družino.')
        return null
      }
      if (familyModes.length === 0) {
        setError('Izberi vsaj en način vadbe za družino.')
        return null
      }
      const effectiveCases = familyLevels.includes('A2') ? familyCases : ['nominative']
      if (familyModes.includes('phrase') && effectiveCases.length === 0) {
        setError('Izberi vsaj en sklon za družino.')
        return null
      }
      config.family = {
        levels: familyLevels,
        modes: familyModes,
        cases: effectiveCases,
        include_plural: familyIncludePlural,
      }
      }
    }
    return config
  }

  const openItemSelection = async (wordType) => {
    if (!wordType) return
    setSelectionModal({
      open: true,
      wordType,
      items: [],
      filter: '',
      loading: true,
    })
    setError('')
    try {
      const data = await apiFetch(`/items?word_type=${wordType}&include_solution=true`)
      const selectedIds = wordType === 'noun' ? versionForm.nounItems : versionForm.verbItems
      const selectedSet = new Set(selectedIds)
      const items = data.map((item) => ({
        ...item,
        selected: selectedSet.has(item.id),
      }))
      setSelectionModal({
        open: true,
        wordType,
        items,
        filter: '',
        loading: false,
      })
    } catch (err) {
      setError(err.message)
      setSelectionModal((prev) => ({ ...prev, loading: false }))
    }
  }

  const closeSelectionModal = () => {
    setSelectionModal({ open: false, wordType: null, items: [], filter: '', loading: false })
  }

  const toggleSelectionItem = (itemId) => {
    setSelectionModal((prev) => ({
      ...prev,
      items: prev.items.map((item) =>
        item.id === itemId ? { ...item, selected: !item.selected } : item,
      ),
    }))
  }

  const selectAllSelectionItems = () => {
    setSelectionModal((prev) => ({
      ...prev,
      items: prev.items.map((item) => ({ ...item, selected: true })),
    }))
  }

  const clearSelectionItems = () => {
    setSelectionModal((prev) => ({
      ...prev,
      items: prev.items.map((item) => ({ ...item, selected: false })),
    }))
  }

  const saveSelectionItems = () => {
    const selectedIds = selectionModal.items
      .filter((item) => item.selected)
      .map((item) => item.id)
    setVersionForm((prev) => {
      if (selectionModal.wordType === 'noun') {
        return { ...prev, nounItems: selectedIds }
      }
      if (selectionModal.wordType === 'verb') {
        return { ...prev, verbItems: selectedIds }
      }
      return prev
    })
    closeSelectionModal()
  }

  const handleCreateVersion = async (event) => {
    event.preventDefault()
    if (!selectedUser || isAnonymous) return
    if (!versionForm.collectionId) return
    if (!versionForm.modules.length) {
      setError('Izberi vsaj en modul.')
      return
    }
    const config = buildCollectionConfig()
    if (!config) return
    setCollectionBusy(true)
    setError('')
    try {
      if (versionForm.mode === 'edit' && versionForm.versionId) {
        await apiFetch(`/collections/versions/${versionForm.versionId}`, {
          method: 'PATCH',
          body: {
            owner_user_id: selectedUser.id,
            title: versionForm.title.trim() || null,
            description: versionForm.description.trim(),
            visibility: versionForm.visibility,
            config,
            noun_item_ids:
              versionForm.nounScope === 'subset' ? versionForm.nounItems : undefined,
            verb_item_ids:
              versionForm.verbScope === 'subset' ? versionForm.verbItems : undefined,
          },
        })
        syncActiveCollectionVersion(versionForm.versionId, {
          versionTitle: versionForm.title.trim(),
          versionDescription: versionForm.description.trim(),
          visibility: versionForm.visibility,
          config,
        })
      } else {
        await apiFetch(`/collections/${versionForm.collectionId}/versions`, {
          method: 'POST',
          body: {
            owner_user_id: selectedUser.id,
            title: versionForm.title.trim() || null,
            description: versionForm.description.trim(),
            visibility: versionForm.visibility,
            config,
            noun_item_ids:
              versionForm.nounScope === 'subset' ? versionForm.nounItems : undefined,
            verb_item_ids:
              versionForm.verbScope === 'subset' ? versionForm.verbItems : undefined,
          },
        })
      }
      closeVersionForm()
      await loadOwnerCollections(selectedUser.id)
      await loadPublicCollections()
    } catch (err) {
      setError(err.message)
    } finally {
      setCollectionBusy(false)
    }
  }

  useEffect(() => {
    loadUsersAndModules()
  }, [loadUsersAndModules])

  useEffect(() => {
    if (!selectedUser || selectedUser.id === ANONYMOUS_USER.id) return
    const refreshed = users.find((user) => user.id === selectedUser.id)
    if (!refreshed) return
    const levelChanged = (refreshed.level ?? 0) !== (selectedUser.level ?? 0)
    const nameChanged = refreshed.name !== selectedUser.name
    if (levelChanged || nameChanged) {
      setSelectedUser(refreshed)
    }
  }, [users, selectedUser])

  useEffect(() => {
    if (selectedUser && selectedModule) {
      loadStats(selectedModule)
    } else {
      setStats(null)
    }
  }, [selectedUser, selectedModule, activeCollectionId])

  useEffect(() => {
    loadPublicCollections()
  }, [loadPublicCollections])

  useEffect(() => {
    const stored = localStorage.getItem(ACTIVE_COLLECTION_STORAGE_KEY)
    if (!stored) return
    try {
      const parsed = JSON.parse(stored)
      if (!parsed?.versionId) {
        localStorage.removeItem(ACTIVE_COLLECTION_STORAGE_KEY)
        return
      }
      setActiveCollection(parsed)
      applyCollectionConfig(parsed.config || {})
      apiFetch(`/modules?collection_version_id=${parsed.versionId}`)
        .then((moduleData) => setModules(moduleData))
        .catch((err) => setError(err.message))
    } catch (err) {
      localStorage.removeItem(ACTIVE_COLLECTION_STORAGE_KEY)
    }
  }, [])

  useEffect(() => {
    if (selectedUser && !isAnonymous) {
      loadOwnerCollections(selectedUser.id)
    } else {
      setOwnerCollections([])
    }
  }, [selectedUser, isAnonymous, loadOwnerCollections])

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
      if (!selectedUser) return
      const payload = {
        user_id: selectedUser.id,
        translation: (editValues.translation || '').trim(),
        solution: editValues.forms.map((value) => (value || '').trim()),
      }
      const proposal = await apiFetch(`/items/${itemId}`, {
        method: 'PUT',
        body: payload,
      })
      setInfoMessage(`Predlog spremembe poslan (#${proposal.id}).`)
      if (canReviewProposals) {
        await loadItemProposals()
      }
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
      if (!selectedUser) return
      const proposal = await apiFetch(`/items/${itemId}?user_id=${selectedUser.id}`, {
        method: 'DELETE',
      })
      setInfoMessage(`Predlog za izbris poslan (#${proposal.id}).`)
      if (canReviewProposals) {
        await loadItemProposals()
      }
      if (editingItemId === itemId) {
        cancelEditing()
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setItemActionLoading(false)
    }
  }

  const reviewItemProposal = async (proposalId, decision) => {
    if (!selectedUser) return
    const proposal = itemProposals.find((item) => item.id === proposalId)
    setProposalActionLoading(true)
    setError('')
    try {
      await apiFetch(`/item-proposals/${proposalId}/review`, {
        method: 'POST',
        body: {
          reviewer_user_id: selectedUser.id,
          status: decision,
        },
      })
      setItemProposals((prev) => prev.filter((item) => item.id !== proposalId))
      setInfoMessage(
        decision === 'approved' ? 'Predlog potrjen.' : 'Predlog zavrnjen.',
      )
      await refreshModules()
      if (!proposal || proposal.word_type === moduleItemsType) {
        await reloadModuleItems(moduleItemsType)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setProposalActionLoading(false)
    }
  }

  const uploadCsv = async (wordType, file) => {
    setImportSummary(null)
    setError('')
    setIsImporting(true)
    try {
      if (!selectedUser) return
      const formData = new FormData()
      formData.append('file', file)
      const result = await apiFetch(`/import/${wordType}?user_id=${selectedUser.id}`, {
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

  const reloadModuleItems = async (wordType) => {
    if (!wordType || wordType === 'number' || wordType === 'family') return
    setIsLoadingItems(true)
    setError('')
    try {
      const data = await apiFetch(`/items?word_type=${wordType}&include_solution=true`)
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
      if (activeCollectionId) {
        body.collection_version_id = activeCollectionId
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
          collection_version_id: activeCollectionId || undefined,
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
          collection_version_id: activeCollectionId || undefined,
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
      if (!selectedUser) return
      const proposal = await apiFetch('/items', {
        method: 'POST',
        body: {
          type: moduleItemsType,
          user_id: selectedUser.id,
          translation: newItem.translation,
          solution: newItem.forms,
        },
      })
      setInfoMessage(`Predlog novega vnosa poslan (#${proposal.id}).`)
      if (canReviewProposals) {
        await loadItemProposals()
      }
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
      if (activeCollectionId) {
        params.set('collection_version_id', String(activeCollectionId))
      }
      familyQuery = params.toString()
    }
    setShowResultsModal(true)
    setResultsWordType(wordType)
    setLoadingResults(true)
    setResultsItems([])
    setError('')
    try {
      const endpoint = (() => {
        if (wordType === 'number') {
          const params = new URLSearchParams({
            include_solution: 'true',
            user_id: String(selectedUser.id),
          })
          if (maxNumberParam !== null) {
            params.set('max_number', String(maxNumberParam))
          }
          if (activeCollectionId) {
            params.set('collection_version_id', String(activeCollectionId))
          }
          return `/numbers/results?${params.toString()}`
        }
        if (wordType === 'family') {
          return `/family/results?${familyQuery}`
        }
        const params = new URLSearchParams({
          word_type: wordType,
          include_solution: 'true',
          user_id: String(selectedUser.id),
        })
        if (activeCollectionId) {
          params.set('collection_version_id', String(activeCollectionId))
        }
        return `/items?${params.toString()}`
      })()
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

  const filteredSelectionItems = useMemo(() => {
    if (!selectionModal.filter.trim()) return selectionModal.items
    const q = selectionModal.filter.toLowerCase()
    return selectionModal.items.filter((item) => {
      const haystack = [item.translation || '', ...(item.solution || [])]
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [selectionModal.items, selectionModal.filter])

  const selectionCount = useMemo(
    () => selectionModal.items.filter((item) => item.selected).length,
    [selectionModal.items],
  )

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
      {infoMessage && (
        <div className="alert info">
          {infoMessage}
          <button type="button" className="close-alert" onClick={() => setInfoMessage('')}>
            ×
          </button>
        </div>
      )}

      <section className="panel-grid">
        <div className="panel">
          <h2>1. Izberi uporabnika</h2>
          {isLoadingData && <p className="hint">Nalagam uporabnike in sklope ...</p>}
          {users.length === 0 && <p>Začni tako, da ustvariš prvega uporabnika.</p>}
          <div className="pill-list">
            <div
              className={`pill ${isAnonymous ? 'active' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => setSelectedUser(ANONYMOUS_USER)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  setSelectedUser(ANONYMOUS_USER)
                }
              }}
            >
              <div>
                <span>Anonimno</span>
                <span className="pill-meta">Brez shranjevanja napredka</span>
              </div>
            </div>
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
                  <div className="user-pill-main">
                    <span className="user-name">{user.name}</span>
                    <span className="pill-meta">ID: {user.id}</span>
                    <span className="pill-meta">
                      Nivo: {USER_LEVEL_LABELS[user.level ?? 0] || user.level}
                    </span>
                  </div>
                  {canAssignLevels && (
                    <label
                      className="user-level-select"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <span className="pill-meta">Nastavi nivo</span>
                      <select
                        value={user.level ?? 0}
                        onChange={(event) => {
                          event.stopPropagation()
                          updateUserLevel(user.id, Number(event.target.value))
                        }}
                        disabled={isUpdatingUserLevel || user.id === selectedUser?.id}
                      >
                        {USER_LEVEL_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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
          <h2>2. Zbirke</h2>
          {activeCollection ? (
            <div className="collection-active">
              <div className="collection-meta-row">
                <strong>{activeCollection.collectionTitle}</strong>
                {activeCollection.collectionDescription && (
                  <span className="collection-description-inline">
                    — {activeCollection.collectionDescription}
                  </span>
                )}
              </div>
              <div className="collection-meta-row">
                <span className="pill-meta">v{activeCollection.versionNumber}</span>
                {activeCollection.versionTitle && (
                  <span className="pill-meta">Verzija: {activeCollection.versionTitle}</span>
                )}
                {activeCollection.versionDescription && (
                  <span className="collection-description-inline">
                    — {activeCollection.versionDescription}
                  </span>
                )}
              </div>
              {activeCollection.ownerName && (
                <div className="collection-meta-row">
                  <span className="pill-meta">Avtor</span>
                  <span className="collection-description-inline">
                    — {activeCollection.ownerName}
                  </span>
                </div>
              )}
              {activeCollection.accessCode && (
                <span className="pill-meta">Koda: {activeCollection.accessCode}</span>
              )}
              <button type="button" className="btn ghost small" onClick={clearActiveCollection}>
                Zapri zbirko
              </button>
            </div>
          ) : (
            <p className="hint">Ni izbrane zbirke (uporabljaš osnovni nabor).</p>
          )}

          <div className="inline-form">
            <input
              type="text"
              placeholder="Koda zbirke"
              value={collectionCode}
              onChange={(event) => setCollectionCode(event.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              onClick={handleResolveCollectionCode}
              disabled={collectionBusy || !collectionCode.trim()}
            >
              Odpri
            </button>
          </div>

          <div className="collection-section">
            <p className="section-title">Javne zbirke</p>
            {publicCollections.length === 0 ? (
              <p className="hint">Trenutno ni javno objavljenih zbirk.</p>
            ) : (
              <div className="collection-list">
                {publicCollections.map((item) => {
                  const collectionDescription = (item.description || '').trim()
                  const versionDescription = (item.version_description || '').trim()
                  return (
                    <div key={item.version_id} className="collection-card">
                      <div className="collection-card-main">
                        <div className="collection-meta-row">
                          <strong>{item.title}</strong>
                          {collectionDescription && (
                            <span className="collection-description-inline">
                              — {collectionDescription}
                            </span>
                          )}
                        </div>
                        <div className="collection-meta-row">
                          <span className="pill-meta">v{item.version_number}</span>
                          {item.version_title && (
                            <span className="pill-meta">{item.version_title}</span>
                          )}
                          {versionDescription && (
                            <span className="collection-description-inline">
                              — {versionDescription}
                            </span>
                          )}
                        </div>
                        {item.owner_name && (
                          <div className="collection-meta-row">
                            <span className="pill-meta">Avtor</span>
                            <span className="collection-description-inline">
                              — {item.owner_name}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="collection-actions">
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => activateCollection(item)}
                          disabled={collectionBusy}
                        >
                          Odpri
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {canManageCollections ? (
            <div className="collection-section">
              <p className="section-title">Moje zbirke</p>
              <form className="collection-form" onSubmit={handleCreateCollection}>
                <input
                  type="text"
                  placeholder="Naziv zbirke"
                  value={newCollection.title}
                  onChange={(event) =>
                    setNewCollection((prev) => ({ ...prev, title: event.target.value }))
                  }
                />
                <input
                  type="text"
                  placeholder="Opis (neobvezno)"
                  value={newCollection.description}
                  onChange={(event) =>
                    setNewCollection((prev) => ({ ...prev, description: event.target.value }))
                  }
                />
                <button type="submit" className="btn primary small" disabled={collectionBusy}>
                  Ustvari zbirko
                </button>
              </form>

              {ownerCollections.length === 0 ? (
                <p className="hint">Še nimaš ustvarjenih zbirk.</p>
              ) : (
                <div className="collection-list">
                  {ownerCollections.map((entry) => (
                    <div key={entry.collection.id} className="collection-card">
                      <div className="collection-card-main">
                        <strong>{entry.collection.title}</strong>
                        {entry.collection.description && (
                          <span className="hint">{entry.collection.description}</span>
                        )}
                      </div>
                      <div className="collection-actions">
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => openVersionForm(entry.collection.id)}
                          disabled={collectionBusy}
                        >
                          Nova verzija
                        </button>
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => openCollectionMetaEdit(entry.collection)}
                          disabled={collectionBusy}
                        >
                          Uredi zbirko
                        </button>
                      </div>
                      {collectionEdit.id === entry.collection.id && (
                        <div className="collection-meta-edit">
                          <input
                            type="text"
                            placeholder="Naziv zbirke"
                            value={collectionEdit.title}
                            onChange={(event) =>
                              setCollectionEdit((prev) => ({
                                ...prev,
                                title: event.target.value,
                              }))
                            }
                          />
                          <input
                            type="text"
                            placeholder="Opis zbirke"
                            value={collectionEdit.description}
                            onChange={(event) =>
                              setCollectionEdit((prev) => ({
                                ...prev,
                                description: event.target.value,
                              }))
                            }
                          />
                          <div className="collection-meta-actions">
                            <button
                              type="button"
                              className="btn primary small"
                              onClick={saveCollectionMetaEdit}
                              disabled={collectionBusy}
                            >
                              Shrani opis
                            </button>
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={cancelCollectionMetaEdit}
                              disabled={collectionBusy}
                            >
                              Prekliči
                            </button>
                          </div>
                        </div>
                      )}
                      <div className="collection-versions">
                        {entry.versions.map((version) => (
                          <div key={version.id} className="collection-version">
                            <div>
                              <span className="pill-meta">v{version.version_number}</span>
                              {version.title && (
                                <span className="pill-meta">{version.title}</span>
                              )}
                              <span className="pill-meta">{version.visibility}</span>
                              {version.access_code && (
                                <span className="pill-meta">Koda: {version.access_code}</span>
                              )}
                            </div>
                            <div className="collection-actions">
                              <select
                                className="visibility-select"
                                value={version.visibility}
                                onChange={(event) =>
                                  handleQuickVisibilityChange(
                                    version.id,
                                    event.target.value,
                                    version.visibility,
                                  )
                                }
                                disabled={collectionBusy}
                              >
                                <option value="draft">Osnutek</option>
                                <option value="unlisted">Neobjavljeno</option>
                                <option value="public">Javno</option>
                              </select>
                              <button
                                type="button"
                                className="btn secondary small"
                                onClick={() => activateOwnerVersion(entry.collection, version)}
                                disabled={collectionBusy}
                              >
                                Odpri
                              </button>
                              <button
                                type="button"
                                className="btn ghost small"
                                onClick={() => openEditVersionForm(entry.collection, version)}
                                disabled={collectionBusy}
                              >
                                Uredi
                              </button>
                              <button
                                type="button"
                                className="btn ghost small"
                                onClick={() => openVersionMetaEdit(version)}
                                disabled={collectionBusy}
                              >
                                Opis
                              </button>
                            </div>
                            {versionEdit.id === version.id && (
                              <div className="version-meta-edit">
                                <input
                                  type="text"
                                  placeholder="Naziv verzije"
                                  value={versionEdit.title}
                                  onChange={(event) =>
                                    setVersionEdit((prev) => ({
                                      ...prev,
                                      title: event.target.value,
                                    }))
                                  }
                                />
                                <input
                                  type="text"
                                  placeholder="Opis verzije"
                                  value={versionEdit.description}
                                  onChange={(event) =>
                                    setVersionEdit((prev) => ({
                                      ...prev,
                                      description: event.target.value,
                                    }))
                                  }
                                />
                                <div className="version-meta-actions">
                                  <button
                                    type="button"
                                    className="btn primary small"
                                    onClick={saveVersionMetaEdit}
                                    disabled={collectionBusy}
                                  >
                                    Shrani opis
                                  </button>
                                  <button
                                    type="button"
                                    className="btn ghost small"
                                    onClick={cancelVersionMetaEdit}
                                    disabled={collectionBusy}
                                  >
                                    Prekliči
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {versionForm.collectionId === entry.collection.id && (
                        <form className="version-form" onSubmit={handleCreateVersion}>
                          <p className="section-title">
                            {versionForm.mode === 'edit'
                              ? `Urejanje verzije${versionForm.versionNumber ? ` v${versionForm.versionNumber}` : ''}`
                              : 'Nova verzija'}
                          </p>
                          <input
                            type="text"
                            placeholder="Naziv verzije (neobvezno)"
                            value={versionForm.title}
                            onChange={(event) =>
                              setVersionForm((prev) => ({ ...prev, title: event.target.value }))
                            }
                          />
                          <input
                            type="text"
                            placeholder="Opis verzije"
                            value={versionForm.description}
                            onChange={(event) =>
                              setVersionForm((prev) => ({
                                ...prev,
                                description: event.target.value,
                              }))
                            }
                          />
                          <label className="select-row">
                            <span>Vidnost</span>
                            <select
                              value={versionForm.visibility}
                              onChange={(event) =>
                                setVersionForm((prev) => ({
                                  ...prev,
                                  visibility: event.target.value,
                                }))
                              }
                            >
                              <option value="draft">Osnutek</option>
                              <option value="unlisted">Neobjavljeno</option>
                              <option value="public">Javno</option>
                            </select>
                          </label>
                          <div className="collection-modules">
                            {COLLECTION_MODULES.map((module) => (
                              <label key={module.key} className="family-option">
                                <input
                                  type="checkbox"
                                  checked={versionForm.modules.includes(module.key)}
                                  onChange={() => toggleVersionModule(module.key)}
                                />
                                <span>{module.label}</span>
                              </label>
                            ))}
                          </div>
                          {versionForm.modules.includes('noun') && (
                            <div className="collection-scope">
                              <p className="section-title">Samostalniki</p>
                              <div className="scope-options">
                                <label className="family-option">
                                  <input
                                    type="radio"
                                    name={`noun-scope-${entry.collection.id}`}
                                    checked={versionForm.nounScope === 'all'}
                                    onChange={() =>
                                      setVersionForm((prev) => ({
                                        ...prev,
                                        nounScope: 'all',
                                        nounItems: [],
                                      }))
                                    }
                                  />
                                  <span>Vsi samostalniki</span>
                                </label>
                                <label className="family-option">
                                  <input
                                    type="radio"
                                    name={`noun-scope-${entry.collection.id}`}
                                    checked={versionForm.nounScope === 'subset'}
                                    onChange={() =>
                                      setVersionForm((prev) => ({
                                        ...prev,
                                        nounScope: 'subset',
                                      }))
                                    }
                                  />
                                  <span>Izbrani samostalniki</span>
                                </label>
                              </div>
                              {versionForm.nounScope === 'subset' && (
                                <div className="scope-actions">
                                  <span className="pill-meta">
                                    Izbranih: {versionForm.nounItems.length}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn secondary small"
                                    onClick={() => openItemSelection('noun')}
                                  >
                                    Izberi samostalnike
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                          {versionForm.modules.includes('verb') && (
                            <div className="collection-scope">
                              <p className="section-title">Glagoli</p>
                              <div className="scope-options">
                                <label className="family-option">
                                  <input
                                    type="radio"
                                    name={`verb-scope-${entry.collection.id}`}
                                    checked={versionForm.verbScope === 'all'}
                                    onChange={() =>
                                      setVersionForm((prev) => ({
                                        ...prev,
                                        verbScope: 'all',
                                        verbItems: [],
                                      }))
                                    }
                                  />
                                  <span>Vsi glagoli</span>
                                </label>
                                <label className="family-option">
                                  <input
                                    type="radio"
                                    name={`verb-scope-${entry.collection.id}`}
                                    checked={versionForm.verbScope === 'subset'}
                                    onChange={() =>
                                      setVersionForm((prev) => ({
                                        ...prev,
                                        verbScope: 'subset',
                                      }))
                                    }
                                  />
                                  <span>Izbrani glagoli</span>
                                </label>
                              </div>
                              {versionForm.verbScope === 'subset' && (
                                <div className="scope-actions">
                                  <span className="pill-meta">
                                    Izbranih: {versionForm.verbItems.length}
                                  </span>
                                  <button
                                    type="button"
                                    className="btn secondary small"
                                    onClick={() => openItemSelection('verb')}
                                  >
                                    Izberi glagole
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                          <span className="hint">
                            {versionForm.mode === 'edit'
                              ? 'Nastavitve za števila in družino ostanejo izbrane iz verzije.'
                              : 'Nastavitve za števila in družino vzamem iz trenutnih nastavitev.'}
                          </span>
                          <div className="collection-actions">
                            <button
                              type="submit"
                              className="btn primary small"
                              disabled={collectionBusy}
                            >
                              {versionForm.mode === 'edit' ? 'Shrani spremembe' : 'Shrani verzijo'}
                            </button>
                            <button
                              type="button"
                              className="btn ghost small"
                              onClick={closeVersionForm}
                              disabled={collectionBusy}
                            >
                              Prekliči
                            </button>
                          </div>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="hint collection-hint">
              Za ustvarjanje zbirk izberi prijavljenega uporabnika.
            </p>
          )}
        </div>

        <div className="panel">
          <h2>3. Izberi sklop</h2>
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
                        disabled={isImporting || !canEditItems}
                      >
                        Uvozi CSV
                      </button>
                      <button
                        type="button"
                        className="btn outline-btn"
                        onClick={() => toggleModuleItems(module.type)}
                        disabled={isLoadingItems || !canEditItems}
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
          {canReviewProposals && (
            <div className="proposal-section">
              <p className="section-title">Predlogi sprememb</p>
              <div className="proposal-filters">
                <input
                  type="text"
                  placeholder="Iskanje"
                  value={proposalFilters.query}
                  onChange={(event) =>
                    setProposalFilters((prev) => ({ ...prev, query: event.target.value }))
                  }
                />
                <select
                  value={proposalFilters.wordType}
                  onChange={(event) =>
                    setProposalFilters((prev) => ({ ...prev, wordType: event.target.value }))
                  }
                >
                  <option value="all">Vsi sklopi</option>
                  <option value="noun">Samostalniki</option>
                  <option value="verb">Glagoli</option>
                </select>
                <select
                  value={proposalFilters.proposalType}
                  onChange={(event) =>
                    setProposalFilters((prev) => ({
                      ...prev,
                      proposalType: event.target.value,
                    }))
                  }
                >
                  <option value="all">Vse vrste</option>
                  <option value="create">Nov vnos</option>
                  <option value="update">Posodobitev</option>
                  <option value="delete">Izbris</option>
                </select>
                <select
                  value={proposalFilters.proposerId}
                  onChange={(event) =>
                    setProposalFilters((prev) => ({
                      ...prev,
                      proposerId: event.target.value,
                    }))
                  }
                >
                  <option value="all">Vsi avtorji</option>
                  {users.map((user) => (
                    <option key={user.id} value={String(user.id)}>
                      {user.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn ghost small"
                  onClick={() =>
                    setProposalFilters({
                      wordType: 'all',
                      proposalType: 'all',
                      proposerId: 'all',
                      query: '',
                    })
                  }
                >
                  Počisti
                </button>
              </div>
              {isLoadingProposals ? (
                <p className="hint">Nalagam predloge ...</p>
              ) : itemProposals.length === 0 ? (
                <p className="hint">Ni odprtih predlogov.</p>
              ) : (
                <div className="proposal-list">
                  {itemProposals.map((proposal) => {
                    const wordLabel = proposal.word_type === 'noun' ? 'Samostalnik' : 'Glagol'
                    const proposalLabel =
                      proposal.proposal_type === 'create'
                        ? 'Nov vnos'
                        : proposal.proposal_type === 'update'
                          ? 'Posodobitev'
                          : 'Izbris'
                    return (
                      <div key={proposal.id} className="proposal-card">
                        <div className="proposal-main">
                          <div className="collection-meta-row">
                            <span className="pill-meta">{wordLabel}</span>
                            <span className="pill-meta">{proposalLabel}</span>
                            {proposal.item_id && (
                              <span className="pill-meta">ID: {proposal.item_id}</span>
                            )}
                          </div>
                          <strong>{proposal.translation}</strong>
                          {proposal.solution?.length > 0 && (
                            <span className="hint">{proposal.solution.join(' · ')}</span>
                          )}
                          <span className="hint">Predlagal: {proposal.proposer_name}</span>
                        </div>
                        <div className="proposal-actions">
                          <button
                            type="button"
                            className="btn primary small"
                            onClick={() => reviewItemProposal(proposal.id, 'approved')}
                            disabled={proposalActionLoading}
                          >
                            Potrdi
                          </button>
                          <button
                            type="button"
                            className="btn ghost small"
                            onClick={() => reviewItemProposal(proposal.id, 'rejected')}
                            disabled={proposalActionLoading}
                          >
                            Zavrni
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
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
                  disabled={Boolean(activeCollectionId)}
                />
              </label>
              <label>
                <span>Velikost cikla</span>
                <input
                  type="number"
                  min="1"
                  value={numberCycleSize}
                  onChange={(event) => setNumberCycleSize(event.target.value)}
                  disabled={Boolean(activeCollectionId)}
                />
              </label>
              <div className="component-toggle">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={useNumberComponents}
                    onChange={(event) => setUseNumberComponents(event.target.checked)}
                    disabled={Boolean(activeCollectionId)}
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
                      disabled={
                        Boolean(activeCollectionId) ||
                        selectedNumberComponents.length === NUMBER_COMPONENTS.length
                      }
                    >
                      Izberi vse
                    </button>
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={clearNumberComponents}
                      disabled={Boolean(activeCollectionId) || selectedNumberComponents.length === 0}
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
                          disabled={Boolean(activeCollectionId)}
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
                        disabled={Boolean(activeCollectionId)}
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
                        disabled={Boolean(activeCollectionId)}
                      />
                      <span>{mode.label}</span>
                    </label>
                  ))}
                  <label className="family-option">
                    <input
                      type="checkbox"
                      checked={familyIncludePlural}
                      onChange={(event) => setFamilyIncludePlural(event.target.checked)}
                      disabled={Boolean(activeCollectionId) || !familyModes.includes('noun')}
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
                          disabled={Boolean(activeCollectionId) || disabled}
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
              <strong>{importSummary.fileName}</strong> | predlogov {importSummary.added},
              preskočenih{' '}
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
                  <h4>Predlagaj nov vnos</h4>
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
                      Predlagaj
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
                                  Predlagaj
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
                                  Predlagaj izbris
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
      {selectionModal.open && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target.classList.contains('modal-backdrop')) {
              closeSelectionModal()
            }
          }}
        >
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>
                Izberi {selectionModal.wordType === 'noun' ? 'samostalnike' : 'glagole'}
              </h3>
              <button type="button" className="close-modal" onClick={closeSelectionModal}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <input
                type="text"
                placeholder="Filter po geslih ali prevodih"
                value={selectionModal.filter}
                onChange={(event) =>
                  setSelectionModal((prev) => ({ ...prev, filter: event.target.value }))
                }
                className="filter-input"
              />
              <div className="selection-toolbar">
                <span className="pill-meta">Izbranih: {selectionCount}</span>
                <div className="selection-actions">
                  <button
                    type="button"
                    className="btn secondary small"
                    onClick={selectAllSelectionItems}
                    disabled={selectionModal.loading || selectionCount === selectionModal.items.length}
                  >
                    Izberi vse
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={clearSelectionItems}
                    disabled={selectionModal.loading || selectionCount === 0}
                  >
                    Počisti vse
                  </button>
                </div>
              </div>
              {selectionModal.loading ? (
                <p>Nalaganje ...</p>
              ) : filteredSelectionItems.length === 0 ? (
                <p>Ni zadetkov.</p>
              ) : (
                <ul className="items-list">
                  {filteredSelectionItems.map((item) => {
                    const term = item.solution ? item.solution.join(' · ') : '–'
                    const translation = item.translation || '–'
                    return (
                      <li key={item.id}>
                        <div className="item-line">
                          <label className="selection-row">
                            <input
                              type="checkbox"
                              checked={Boolean(item.selected)}
                              onChange={() => toggleSelectionItem(item.id)}
                            />
                            <span className="term">{term}</span>
                          </label>
                          <span className="translation">{translation}</span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              <div className="selection-footer">
                <button type="button" className="btn primary" onClick={saveSelectionItems}>
                  Potrdi izbor
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
