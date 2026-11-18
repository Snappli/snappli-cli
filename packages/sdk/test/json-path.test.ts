import { describe, expect, it } from 'vitest';
import {
  previewResponseMapping,
  readJsonPath,
  renderMappingNote,
  shapeConnectorResponse,
} from '../src/index.js';

// Mismos casos que connector-operation.util.spec.ts del backend.
const data = { slots: [{ hora: '09:00' }, { hora: '10:00' }], a: { b: [{ c: 1 }] } };

describe('readJsonPath', () => {
  it('se comporta como el del backend', () => {
    expect(readJsonPath(data, '$.slots[*].hora')).toEqual(['09:00', '10:00']);
    expect(readJsonPath(data, '$.a.b[0].c')).toBe(1);
    expect(readJsonPath(data, '$.nope')).toBeUndefined();
  });

  it('raíz, índices fuera de rango y valores falsy', () => {
    expect(readJsonPath(data, '$')).toBe(data);
    expect(readJsonPath(data, '$.slots[5].hora')).toBeUndefined();
    expect(readJsonPath({ x: 0, y: false, z: null }, '$.x')).toBe(0);
    expect(readJsonPath({ y: false }, '$.y')).toBe(false);
    expect(readJsonPath({ z: null }, '$.z')).toBeNull();
    expect(readJsonPath([{ id: 'a' }], '$[0].id')).toBe('a');
  });
});

describe('shapeConnectorResponse', () => {
  it('aplica el responseMap y recorta a 2048', () => {
    expect(shapeConnectorResponse(JSON.stringify(data), { horarios: '$.slots[*].hora' })).toEqual({
      text: '{"horarios":["09:00","10:00"]}',
      mapped: true,
      truncated: false,
    });
    const long = shapeConnectorResponse(JSON.stringify({ x: 'y'.repeat(5000) }), null);
    expect(long.mapped).toBe(false);
    expect(long.truncated).toBe(true);
    expect(long.text.endsWith('…(recortado)')).toBe(true);
  });

  it('texto no JSON', () => {
    expect(shapeConnectorResponse('hola\n  mundo')).toEqual({
      text: 'hola mundo',
      mapped: false,
      truncated: false,
    });
  });
});

describe('previewResponseMapping', () => {
  it('lee los campos y rellena la nota', () => {
    const out = previewResponseMapping(
      {
        fields: { id_pedido: '$.data.id', total: '$.data.total', lista: '$.data.items' },
        note: 'Pedido {{id_pedido}}',
      },
      JSON.stringify({ data: { id: 'PED-123', items: [1] } }),
    );
    expect(out.fields).toEqual([
      { key: 'id_pedido', path: '$.data.id', value: 'PED-123', saved: false },
      {
        key: 'total',
        path: '$.data.total',
        value: null,
        saved: false,
        reason: 'No está $.data.total en la respuesta',
      },
      { key: 'lista', path: '$.data.items', value: null, saved: false, reason: 'Sin valor simple' },
    ]);
    expect(out.note).toBe('Pedido PED-123');
    expect(out.warnings).toEqual([]);
  });

  it('avisa si la respuesta no es JSON o viene vacía', () => {
    expect(previewResponseMapping({ fields: { a: '$.a' } }, 'OK').warnings).toEqual([
      'La respuesta no es JSON',
    ]);
    expect(previewResponseMapping({ fields: {} }, '').warnings).toEqual([
      'La respuesta vino vacía',
    ]);
  });

  it('la nota admite contact. y custom. como en el backend', () => {
    expect(renderMappingNote('{{contact.custom.a}} y {{ b }}', { a: '1', b: '2' })).toBe('1 y 2');
  });
});
