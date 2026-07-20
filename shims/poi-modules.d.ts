declare module 'views/create-store' {
  export const store: {
    dispatch: (action: unknown) => unknown
    getState: () => PoiRootState
  }
}

declare module 'views/utils/selectors' {
  export const fleetShipsDataSelectorFactory: (
    fleetId: number,
  ) => (state: PoiRootState) => unknown[] | undefined
  export const fleetShipsEquipDataSelectorFactory: (
    fleetId: number,
  ) => (state: PoiRootState) => unknown[][] | undefined
}

declare module 'views/utils/game-utils' {
  export const getFleetSpeed: (shipsData: unknown[]) => { speed: number }
  export const getSaku33: (
    shipsData: unknown[],
    equipsData: unknown[][],
    teitokuLv: number,
    mapModifier?: number,
    slotCount?: number,
  ) => number
}
