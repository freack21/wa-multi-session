export const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const is = {
  array: (array: any): boolean => {
    return typeof array === 'object' && array != null && array.length > 0;
  },
  undefined: (elem: any): boolean => {
    return typeof elem === 'undefined';
  },
  file: (file: any): boolean => {
    return file instanceof File;
  },
  object: (object: any): boolean => {
    return typeof object === 'object' && object != null && Object.keys(object).length > 0;
  },
  string: (str: any): boolean => {
    return typeof str === 'string';
  },
};

export const to = {
  string: (str: any): string => {
    if (typeof str === 'string') return str;
    return '';
  },
  undefined: (str: any, defaultValue: any = undefined): string | number | undefined => {
    if ((typeof str === 'string' || typeof str === 'number') && str !== '') return str;
    return defaultValue;
  },
};
