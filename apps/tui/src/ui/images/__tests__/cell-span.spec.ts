import { describe, expect, it } from 'bun:test'

import { NO_ROOM, imageCellSpan } from '../cell-span'

describe('imageCellSpan', () => {
  it('keeps a small image at its own size rather than blowing it up', () => {
    const span = imageCellSpan({
      source: { width: 20, height: 20 },
      availableColumns: 100,
      maxRows: 40,
    })

    expect(span).toEqual({ columns: 10, rows: 5 })
  })

  it('holds a square square, given a cell twice as tall as it is wide', () => {
    const span = imageCellSpan({
      source: { width: 400, height: 400 },
      availableColumns: 40,
      maxRows: 40,
    })

    expect(span).toEqual({ columns: 40, rows: 20 })
  })

  it('follows the cell aspect it is handed', () => {
    const span = imageCellSpan({
      source: { width: 400, height: 400 },
      availableColumns: 40,
      maxRows: 40,
      cellAspect: 1,
    })

    expect(span).toEqual({ columns: 40, rows: 40 })
  })

  it('narrows rather than squashes when the row cap bites', () => {
    const span = imageCellSpan({
      source: { width: 400, height: 400 },
      availableColumns: 40,
      maxRows: 5,
    })

    expect(span).toEqual({ columns: 10, rows: 5 })
  })

  it('gives a wide image the full width and few rows', () => {
    const span = imageCellSpan({
      source: { width: 1600, height: 200 },
      availableColumns: 80,
      maxRows: 20,
    })

    expect(span).toEqual({ columns: 80, rows: 5 })
  })

  it('never collapses to nothing on an extreme ratio', () => {
    const span = imageCellSpan({
      source: { width: 2000, height: 3 },
      availableColumns: 60,
      maxRows: 20,
    })

    expect(span).toEqual({ columns: 60, rows: 1 })
  })

  it('holds a small image to its own pixels, given the cell it will be drawn in', () => {
    const span = imageCellSpan({
      source: { width: 64, height: 64 },
      availableColumns: 100,
      maxRows: 40,
      cellWidth: 8,
    })

    expect(span).toEqual({ columns: 8, rows: 4 })
  })

  it('still spends the width it is given on an image with pixels to spare', () => {
    const span = imageCellSpan({
      source: { width: 900, height: 900 },
      availableColumns: 60,
      maxRows: 40,
      cellWidth: 8,
    })

    expect(span).toEqual({ columns: 60, rows: 30 })
  })

  it('falls back to the block sampler when the cell size is unknown', () => {
    const span = imageCellSpan({
      source: { width: 20, height: 20 },
      availableColumns: 100,
      maxRows: 40,
      cellWidth: 0,
    })

    expect(span).toEqual({ columns: 10, rows: 5 })
  })

  it('reports no room rather than a zero-sized span', () => {
    expect(
      imageCellSpan({ source: { width: 8, height: 8 }, availableColumns: 0, maxRows: 10 }),
    ).toEqual(NO_ROOM)
    expect(
      imageCellSpan({ source: { width: 8, height: 8 }, availableColumns: 10, maxRows: 0 }),
    ).toEqual(NO_ROOM)
    expect(
      imageCellSpan({ source: { width: 0, height: 0 }, availableColumns: 10, maxRows: 10 }),
    ).toEqual(NO_ROOM)
  })
})
