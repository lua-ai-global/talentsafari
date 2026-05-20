// Copyright © 2020-2023 Truestamp Inc. All rights reserved.

/* eslint-disable  @typescript-eslint/ban-ts-comment */

import { describe, test, expect } from 'vitest'

import { canonify } from '../src/index'

describe('serializing', () => {
  describe('should behave like JSON.stringify() for', () => {
    // See JSON.stringify() for more documentation and examples.
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify

    // JSON.stringify(undefined)
    // undefined
    test('undefined', () => {
      expect(canonify(undefined)).toEqual(undefined)
    })

    // JSON.stringify(null)
    // 'null'
    test('null', () => {
      expect(canonify(null)).toEqual('null')
    })

    // JSON.stringify(true)
    // 'true'
    test('true', () => {
      expect(canonify(true)).toEqual('true')
    })

    // JSON.stringify(false)
    // 'false'
    test('false', () => {
      expect(canonify(false)).toEqual('false')
    })

    // JSON.stringify(() => { })
    // undefined
    test('function', () => {
      expect(
        canonify(() => {
          console.log('hello')
        }),
      ).toEqual(undefined)
    })

    // > JSON.stringify(Symbol('hello world'))
    // undefined
    test('symbol', () => {
      expect(canonify(Symbol('hello world'))).toEqual(undefined)
    })

    // JSON.stringify(42)
    // '42'
    test('number', () => {
      expect(canonify(42)).toEqual('42')
    })

    // > JSON.stringify([NaN, null, Infinity]);
    // '[null,null,null]'
    test('number, NaN, Infinity', () => {
      expect(canonify([NaN, null, Infinity])).toEqual('[null,null,null]')
    })

    // > JSON.stringify(Math.pow(2, 1000))
    // '1.0715086071862673e+301'
    test('large integer number', () => {
      expect(canonify(Math.pow(2, 1000))).toEqual('1.0715086071862673e+301')
    })

    // > JSON.stringify(BigInt(9007199254740991))
    // Uncaught TypeError: Do not know how to serialize a BigInt
    // at JSON.stringify(<anonymous>)
    test('BigInt should throw a TypeError', () => {
      const t = () => {
        const bigint = BigInt(9007199254740991)
        canonify(bigint)
      }
      expect(t).toThrow(TypeError)
      expect(t).toThrow("BigInt value can't be serialized in JSON")
    })

    // JSON.stringify('foo')
    // '"foo"'
    test('string', () => {
      expect(canonify('foo')).toEqual('"foo"')
    })

    test('Date conversion to string', () => {
      expect(canonify(new Date(Date.UTC(2006, 0, 2, 15, 4, 5)))).toEqual(
        '"2006-01-02T15:04:05.000Z"',
      )
    })

    // > JSON.stringify("\u20ac")
    // '"€"'
    test('a unicode code point', () => {
      expect(canonify('\u20ac')).toEqual('"€"')
    })

    // JSON.stringify([undefined, null, true, false, "foo", 42, BigInt(42).toString(), Symbol('hello'), () => { }])
    // '[null,null,true,false,"foo",42,"42",null,null]'
    test('Array', () => {
      const a = [
        undefined,
        null,
        true,
        false,
        'foo',
        42,
        BigInt(42).toString(),
        Symbol('hello'),
        () => {
          console.log('hello')
        },
      ]
      expect(canonify(a)).toEqual(
        '[null,null,true,false,"foo",42,"42",null,null]',
      )
    })

    test('Array with String keys', () => {
      const a = ['foo', 'bar']
      // @ts-ignore-next-line
      a['baz'] = 'quux' // a: [ 0: 'foo', 1: 'bar', baz: 'quux' ]
      expect(canonify(a)).toEqual('["foo","bar"]')
    })

    // > JSON.stringify({ big: BigInt(42).toString(), f: false, fun: () => { }, n: null, num: 42, s: "string", sym: Symbol('hello'), t: true, u: undefined })
    // '{"big":"42","f":false,"n":null,"num":42,"s":"string","t":true}'
    test('Object', () => {
      const o = {
        big: BigInt(42).toString(),
        f: false,
        fun: () => {
          console.log('hello')
        },
        n: null,
        num: 42,
        s: 'string',
        sym: Symbol('hello'),
        t: true,
        u: undefined,
      }
      expect(canonify(o)).toEqual(
        '{"big":"42","f":false,"n":null,"num":42,"s":"string","t":true}',
      )
    })

    // Standard data structures
    // JSON.stringify([new Set([1]), new Map([[1, 2]]), new WeakSet([{ a: 1 }]), new WeakMap([[{ a: 1 }, 2]])]);
    // '[{},{},{},{}]'
    test('standard data structures', () => {
      const o = [
        new Set([1]),
        new Map([[1, 2]]),
        new WeakSet([{ a: 1 }]),
        new WeakMap([[{ a: 1 }, 2]]),
      ]
      expect(canonify(o)).toEqual('[{},{},{},{}]')
    })

    // TypedArray
    // JSON.stringify([new Int8Array([1]), new Int16Array([1]), new Int32Array([1])]);
    // '[{"0":1},{"0":1},{"0":1}]'
    // JSON.stringify([new Uint8Array([1]), new Uint8ClampedArray([1]), new Uint16Array([1]), new Uint32Array([1])]);
    // '[{"0":1},{"0":1},{"0":1},{"0":1}]'
    // JSON.stringify([new Float32Array([1]), new Float64Array([1])]);
    // '[{"0":1},{"0":1}]'
    test('TypedArray', () => {
      const e1 = [new Int8Array([1]), new Int16Array([1]), new Int32Array([1])]
      expect(canonify(e1)).toEqual('[{"0":1},{"0":1},{"0":1}]')

      const e2 = [
        new Uint8Array([1]),
        new Uint8ClampedArray([1]),
        new Uint16Array([1]),
        new Uint32Array([1]),
      ]
      expect(canonify(e2)).toEqual('[{"0":1},{"0":1},{"0":1},{"0":1}]')

      const e3 = [new Float32Array([1]), new Float64Array([1])]
      expect(canonify(e3)).toEqual('[{"0":1},{"0":1}]')
    })

    // JSON.stringify({ x: undefined, y: Object, z: Symbol('') });
    // '{}'
    // JSON.stringify({ [Symbol('foo')]: 'foo' });
    // '{}'
    // JSON.stringify({ [Symbol.for('foo')]: 'foo' }, [Symbol.for('foo')]);
    // '{}'
    test('Symbols', () => {
      // @ts-ignore-next-line
      const e1 = { x: undefined, y: Object, z: Symbol('') }
      expect(canonify(e1)).toEqual('{}')

      // @ts-ignore-next-line
      const e2 = { [Symbol('foo')]: 'foo' }
      expect(canonify(e2)).toEqual('{}')

      const e3 = [{ [Symbol.for('foo')]: 'foo' }, [Symbol.for('foo')]]
      expect(canonify(e3)).toEqual('[{},[null]]')
    })

    // JSON.stringify(Object.create(null, { x: { value: 'x', enumerable: false }, y: { value: 'y', enumerable: true } }));
    // '{"y":"y"}'
    test('Non-enumerable properties', () => {
      const o = Object.create(null, {
        x: { value: 'x', enumerable: false },
        y: { value: 'y', enumerable: true },
      })
      expect(canonify(o)).toEqual('{"y":"y"}')
    })

    test('Serializing Unicode strings, control chars, lone surrogates', () => {
      expect(canonify('\uD800')).toEqual('"\\ud800"')
      expect(canonify('\uDEAD')).toEqual('"\\udead"')
      expect(canonify('\u0008')).toEqual('"\\b"')
      expect(canonify('\u0009')).toEqual('"\\t"')
      expect(canonify('\u000A')).toEqual('"\\n"')
      expect(canonify('\u000C')).toEqual('"\\f"')
      expect(canonify('\u000D')).toEqual('"\\r"')
      expect(canonify('\u005C')).toEqual('"\\\\"')
      expect(canonify('\u0022')).toEqual('"\\""')
    })

    // FIXME
    // test('toJSON', () => {
    //   var obj = {
    //     data: 'data',

    //     // @ts-ignore-next-line
    //     toJSON(key) {
    //       if (key) {
    //         return `Now I am a nested object under key '${key}'`;
    //       } else {
    //         // return this;
    //       }
    //     }
    //   };

    //   expect(canonify(obj)).toEqual('{"data":"data"}')
    //   expect(canonify({ obj })).toEqual('{"obj":"Now I am a nested object under key \'obj\'"}')
    //   expect(canonify([obj])).toEqual('["Now I am a nested object under key \'0\'"]')
    // })
  })

  describe('arrays should handle', () => {
    test('an empty array', () => {
      expect(canonify([])).toEqual('[]')
    })

    test('a one element string array', () => {
      expect(canonify(['abc'])).toEqual('["abc"]')
    })

    test('a one element number array', () => {
      expect(canonify([123])).toEqual('[123]')
    })

    test('a one element boolean true array', () => {
      expect(canonify([true])).toEqual('[true]')
    })

    test('a one element boolean false array', () => {
      expect(canonify([false])).toEqual('[false]')
    })

    test('a one element null array', () => {
      expect(canonify([null])).toEqual('[null]')
    })

    test('a one element undefined array', () => {
      expect(canonify([undefined])).toEqual('[null]')
    })

    test('a one element Symbol array', () => {
      expect(canonify([Symbol('hello world')])).toEqual('[null]')
    })

    test('a one element function array', () => {
      const f = function foo() {
        console.log('hello')
      }
      expect(canonify([f])).toEqual('[null]')
    })

    test('a nested array', () => {
      expect(canonify([['b', 'a']])).toEqual('[["b","a"]]')
    })

    test('an object in an array', () => {
      expect(canonify([{ b: 123, a: 'string' }])).toEqual(
        '[{"a":"string","b":123}]',
      )
    })

    test('a multi-element array', () => {
      expect(canonify(['abc', 123, true, false, null])).toEqual(
        '["abc",123,true,false,null]',
      )
    })
  })

  describe('objects should handle', () => {
    test('an empty object', () => {
      expect(canonify({})).toEqual('{}')
    })

    test('object with one key', () => {
      expect(canonify({ hello: 'world' })).toEqual('{"hello":"world"}')
    })

    test('an object with a number key', () => {
      expect(canonify({ 42: 'foo' })).toEqual('{"42":"foo"}')
    })

    test('an object with a Symbol key', () => {
      expect(canonify({ [Symbol('hello world')]: 'foo' })).toEqual('{}')
    })

    test('an object with more than one key should sort keys', () => {
      expect(canonify({ number: 123, hello: 'world' })).toEqual(
        '{"hello":"world","number":123}',
      )
    })

    test('an object with null value', () => {
      expect(canonify({ test: null })).toEqual('{"test":null}')
    })

    test('object with undefined value', () => {
      expect(canonify({ test: undefined })).toEqual('{}')
    })

    test('object with a Symbol value', () => {
      expect(canonify({ test: Symbol('hello world') })).toEqual('{}')
    })

    test('an object with object value', () => {
      expect(canonify({ test: { hello: 'world' } })).toEqual(
        '{"test":{"hello":"world"}}',
      )
    })

    test('an object with array value', () => {
      expect(canonify({ test: ['hello', 'world'] })).toEqual(
        '{"test":["hello","world"]}',
      )
    })

    test('an object with a function value', () => {
      const f = function foo() {
        console.log('hello')
      }
      expect(canonify({ test: f })).toEqual('{}')
    })

    test('an object with a toJSON serializer function value', () => {
      const input = {
        a: 123,
        b: 456,
        toJSON: function () {
          // c: is only present in the serialized output
          return {
            c: 'foo',
            b: this.b,
            a: this.a,
          }
        },
      }

      expect(canonify(input)).toEqual('{"a":123,"b":456,"c":"foo"}')
    })
  })

  describe('classes should handle', () => {
    test('a class with a toJSON serializer function', () => {
      class Foo {
        a: number
        b: number
        constructor(a: number, b: number) {
          this.a = a
          this.b = b
        }

        // c: is only present in the serialized output
        toJSON() {
          return { c: 'foo', b: this.b, a: this.a }
        }
      }

      const f = new Foo(123, 456)

      expect(canonify(f)).toEqual('{"a":123,"b":456,"c":"foo"}')
    })

    test('a class with no toJSON serializer function', () => {
      class Foo {
        b: number
        a: number
        constructor(b: number, a: number) {
          this.b = b
          this.a = a
        }

        ignoredFunction() {
          return { bogus: true }
        }
      }

      const f = new Foo(456, 123)

      expect(canonify(f)).toEqual('{"a":123,"b":456}')
    })
  })
})
