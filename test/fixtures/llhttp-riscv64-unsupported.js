'use strict'

Object.defineProperty(process, 'arch', {
  ...Object.getOwnPropertyDescriptor(process, 'arch'),
  value: 'riscv64'
})

require('../..')
