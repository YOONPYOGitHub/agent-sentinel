import { Select } from '@fluentui/react-components'

import { useEstate } from '../hooks/useEstate'

export function EstateSelector() {
  const { selectEstate, state } = useEstate()
  if (state.status !== 'ready' || state.estates.length < 2) return null

  return (
    <label className="estate-selector">
      <span>Estate</span>
      <Select
        aria-label="Active estate"
        value={state.selectedEstate.id}
        onChange={(_event, data) => selectEstate(data.value)}
      >
        {state.estates.map((estate) => (
          <option key={estate.id} value={estate.id}>
            {estate.name}
          </option>
        ))}
      </Select>
    </label>
  )
}
