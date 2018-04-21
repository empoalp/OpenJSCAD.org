
function makeJscad (targetElement, options) {
  const defaults = {
    name: 'jscad'
  }
  const {name} = Object.assign({}, defaults, options)

  //
  const bel = require('bel')

  const jscadEl = bel`<div class='jscad' key=${name}></div>`
  targetElement.appendChild(jscadEl)

  const path = require('path')
  const most = require('most')
  const {proxy} = require('most-proxy')
  const {makeState} = require('./state')
  const makeCsgViewer = require('@jscad/csg-viewer')
  let csgViewer

  // all the side effects : ie , input/outputs
  // fake file system
  const fs = require('./sideEffects/memFs')()
  // storage
  const storage = require('./sideEffects/localStorage')(name)
  // title bar side effect
  const titleBar = require('@jscad/core/sideEffects/titleBar')()
  // drag & drop side effect // FIXME: unify with the one in core()
  const dragDrop = require('./sideEffects/dragDrop')(jscadEl)
  // dom side effect
  const dom = require('@jscad/core/sideEffects/dom')({targetEl: jscadEl})
  // worker side effect
  const makeWorkerEffect = require('@jscad/core/sideEffects/worker')

  // internationalization side effect
  const absFooHorror = '/Users/kraftwerk-mb/dev/projects/openjscad/core/tmp/OpenJSCAD.org/packages/web/web/'
  const localesPath = path.resolve(absFooHorror, path.join(absFooHorror, '..', 'locales'))
  console.log('localesPath', localesPath)
  const i18n = require('@jscad/core/sideEffects/i18n')({localesPath})
  // web workers
  const foo = require('./core/code-evaluation/rebuildSolidsWorker.js')// require(workerPath)//path.resolve
  const solidWorker = makeWorkerEffect(foo)
  // generic design parameter handling
  const paramsCallbacktoStream = require('@jscad/core/observable-utils/callbackToObservable')()

  // proxy state stream to be able to access & manipulate it before it is actually available
  const { attach, stream } = proxy()
  const state$ = stream

  // all the sources of data
  const sources = {
    state$,
    paramChanges: paramsCallbacktoStream.stream,
    store: storage.source(),
    fs: fs.source(),
    drops: dragDrop.source(),
    dom: dom.source(),
    solidWorker: solidWorker.source(),
    i18n: i18n.source()
  }

  // all the actions
  const designActions = require('./ui/design/actions')(sources)
  const ioActions = require('./ui/io/actions')(sources)
  const viewerActions = require('./ui/viewer/actions')(sources)
  const otherActions = require('./ui/actions')(sources)
  const actions$ = Object.assign({}, designActions, otherActions, ioActions, viewerActions)

  attach(makeState(Object.values(actions$)))

  // TODO : move to side effect
  actions$.exportRequested$.forEach(action => {
    console.log('export requested', action)
    const {saveAs} = require('file-saver')
    const {prepareOutput} = require('./core/io/prepareOutput')
    const {convertToBlob} = require('./core/io/convertToBlob')

    const outputData = action.data.data
    const format = action.data.exportFormat
    const blob = convertToBlob(prepareOutput(outputData, {format}))
    // fs.writeFileSync(filePath, buffer)
    saveAs(blob, action.data.defaultExportFilePath)
  })

  // after this point, formating of data data that goes out to the sink side effects
  // titlebar & store side effects
  /* FIXME/ not compatible with multiple instances !!
  titleBar.sink(
    state$.map(state => state.appTitle).skipRepeats()
  ) */

  const settingsStorage = state => {
    const {themeName, design, locale, shortcuts} = state
    const {name, mainPath, vtreeMode, paramDefinitions, paramDefaults, paramValues} = design
    return {
      themeName,
      locale,
      shortcuts,
      design: {
        name,
        mainPath,
        vtreeMode,
        parameters: {
          paramDefinitions,
          paramDefaults,
          paramValues
        }
      },
      viewer: {
        axes: {show: state.viewer.axes.show},
        grid: {show: state.viewer.grid.show}
        // autorotate: {enabled: state.viewer.controls.autoRotate.enabled}
      },
      autoReload: state.autoReload,
      instantUpdate: state.instantUpdate
    }
  }
  storage.sink(
    state$
      .map(settingsStorage)
  )

  sources.fs.forEach(x => console.log('got some stuff back', x))

  // data out to file system sink
  const {walkFileTree} = require('./exp/walkFileTree')
  // drag & drops of files/folders have DUAL meaning:
  // * ADD this file/folder to the available ones
  // * OPEN this file/folder
  fs.sink(
    most.mergeArray([
      // injection from drag & drop
      sources.drops
        /* .flatMap(({data}) => {
          return require('most').fromPromise(walkFileTree(data))
        }) */
        .map((data) => ({operation: 'add', data: data.data})),
      sources.drops
        .map(({data}) => ({operation: 'read', data, id: 'loadScript', path: data[0].fullPath}))
        .delay(1000),
      // watched data
      state$
        .filter(state => state.design.mainPath !== '')
        .map(state => ({path: state.design.mainPath, enabled: state.autoReload}))
        .skipRepeatsWith((state, previousState) => {
          return JSON.stringify(state) === JSON.stringify(previousState)
        })
        .map(({path, enabled}) => ({
          operation: 'watch',
          id: 'watchScript',
          path,
          options: {enabled}})// enable/disable watch if autoreload is set to false
        ),
      // files to read/write
      state$
        .filter(state => state.design.mainPath !== '')
        .map(state => state.design.mainPath)
        .skipRepeatsWith((state, previousState) => {
          return JSON.stringify(state) === JSON.stringify(previousState)
        })
        .map(path => ({operation: 'read', id: 'loadScript', path}))
      /* most.just()
        .map(function () {
           const electron = require('electron').remote
          const userDataPath = electron.app.getPath('userData')
          const path = require('path')

          const cachePath = path.join(userDataPath, '/cache.js')
          const cachePath = 'gnagna'
          return {operation: 'read', id: 'loadCachedGeometry', path: cachePath}
        }) */
    ])
  )

  // web worker sink
  const solidWorkerBase$ = most.mergeArray([
    actions$.setDesignContent$.map(action => ({paramValues: undefined, origin: 'designContent', error: undefined})),
    actions$.updateDesignFromParams$.map(action => action.data)
  ]).multicast()

  solidWorker.sink(
    most.sample(function ({origin, paramValues, error}, {design, instantUpdate}) {
      if (error) {
        return undefined
      }
      console.log('design stuff', design)
      const applyParameterDefinitions = require('@jscad/core/parameters/applyParameterDefinitions')
      paramValues = paramValues || design.paramValues // this ensures the last, manually modified params have upper hand
      paramValues = paramValues ? applyParameterDefinitions(paramValues, design.paramDefinitions) : paramValues
      if (!instantUpdate && origin === 'instantUpdate') {
        return undefined
      }
      // console.log('sending paramValues', paramValues, 'options', vtreeMode)
      const options = {vtreeMode: design.vtreeMode, lookup: design.lookup, lookupCounts: design.lookupCounts}
      return {source: design.source, mainPath: design.mainPath, paramValues, options}
    },
    solidWorkerBase$,
    solidWorkerBase$,
    state$
      .filter(state => state.design.mainPath !== '')
      .skipRepeats()
  )
    .filter(x => x !== undefined)
    .map(({source, mainPath, paramValues, options}) => ({cmd: 'render', source, mainPath, parameters: paramValues, options}))
)

// viewer data
  state$
  .filter(state => state.design.mainPath !== '')
  .skipRepeatsWith(function (state, previousState) {
    // const sameParamDefinitions = JSON.stringify(state.design.paramDefinitions) === JSON.stringify(previousState.design.paramDefinitions)
    // const sameParamValues = JSON.stringify(state.design.paramValues) === JSON.stringify(previousState.design.paramValues)
    const sameSolids = state.design.solids.length === previousState.design.solids.length &&
    JSON.stringify(state.design.solids) === JSON.stringify(previousState.design.solids)
    return sameSolids
  })
  .forEach(state => {
    if (csgViewer !== undefined) {
      csgViewer(undefined, {solids: state.design.solids})
    }
  })

  const outToDom$ = state$
  .skipRepeatsWith(function (state, previousState) {
    const sameParamDefinitions = JSON.stringify(state.design.paramDefinitions) === JSON.stringify(previousState.design.paramDefinitions)
    const sameParamValues = JSON.stringify(state.design.paramValues) === JSON.stringify(previousState.design.paramValues)

    const sameInstantUpdate = state.instantUpdate === previousState.instantUpdate

    const sameExportFormats = state.exportFormat === previousState.exportFormat &&
      state.availableExportFormats === previousState.availableExportFormats

    const sameStyling = state.themeName === previousState.themeName

    const sameAutoreload = state.autoReload === previousState.autoReload

    const sameError = JSON.stringify(state.error) === JSON.stringify(previousState.error)
    const sameStatus = state.busy === previousState.busy

    const sameShowOptions = state.showOptions === previousState.showOptions
    const samevtreeMode = state.vtreeMode === previousState.vtreeMode

    const sameAppUpdates = JSON.stringify(state.appUpdates) === JSON.stringify(previousState.appUpdates)

    const sameLocale = state.locale === previousState.locale
    const sameAvailableLanguages = state.availableLanguages === previousState.availableLanguages

    const sameShortcuts = state.shortcuts === previousState.shortcuts

    return sameParamDefinitions && sameParamValues && sameExportFormats && sameStatus && sameStyling &&
      sameAutoreload && sameInstantUpdate && sameError && sameShowOptions && samevtreeMode && sameAppUpdates &&
      sameLocale && sameAvailableLanguages && sameShortcuts
  })
  .map(function (state) {
    return require('./ui/views/main')(state, paramsCallbacktoStream)
  })
  /* .combine(function (state, i18n) {
    console.log('here')
    return require('./ui/views/main')(state, paramsCallbacktoStream, i18n)
  }, sources.i18n.filter(x => x.operation === 'changeSettings').map(x => x.data))
  */
  dom.sink(outToDom$)

  state$
  .map(state => state.viewer)
  .skipRepeatsWith(function (state, previousState) {
    const sameViewerParams = JSON.stringify(state) === JSON.stringify(previousState)
    return sameViewerParams
  })
  .forEach(params => {
    const viewerElement = jscadEl.querySelector('#renderTarget')
    // initialize viewer if it has not been done already
    if (viewerElement && !csgViewer) {
      const csgViewerItems = makeCsgViewer(viewerElement, params)
      csgViewer = csgViewerItems.csgViewer

      // const bar = require('most-gestures').pointerGestures(jscadEl.querySelector('#renderTarget'))
    }
    if (csgViewer) {
      // console.log('params', params)
      csgViewer(params)
    }
  })

  return {}
}

module.exports = makeJscad
