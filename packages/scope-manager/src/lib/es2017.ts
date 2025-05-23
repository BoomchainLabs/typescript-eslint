// THIS CODE WAS AUTOMATICALLY GENERATED
// DO NOT EDIT THIS CODE BY HAND
// RUN THE FOLLOWING COMMAND FROM THE WORKSPACE ROOT TO REGENERATE:
// npx nx generate-lib repo

import type { LibDefinition } from '../variable';

import { es2016 } from './es2016';
import { es2017_arraybuffer } from './es2017.arraybuffer';
import { es2017_date } from './es2017.date';
import { es2017_intl } from './es2017.intl';
import { es2017_object } from './es2017.object';
import { es2017_sharedmemory } from './es2017.sharedmemory';
import { es2017_string } from './es2017.string';
import { es2017_typedarrays } from './es2017.typedarrays';

export const es2017: LibDefinition = {
  libs: [
    es2016,
    es2017_arraybuffer,
    es2017_date,
    es2017_intl,
    es2017_object,
    es2017_sharedmemory,
    es2017_string,
    es2017_typedarrays,
  ],
  variables: [],
};
