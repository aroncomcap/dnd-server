'use strict';

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

const worldExtractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scene', 'locations', 'npcs', 'enemies', 'accomplishments', 'charUpdates'],
  properties: {
    scene: {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'mood', 'npc'],
      properties: {
        action: { type: 'string' },
        mood: { type: 'string' },
        npc: nullableString,
      },
    },
    locations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'distance', 'isNew', 'img'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          distance: { type: 'string' },
          isNew: { type: 'boolean' },
          img: nullableString,
        },
      },
    },
    npcs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'location', 'isNew', 'img'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          isNew: { type: 'boolean' },
          img: nullableString,
        },
      },
    },
    enemies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['displayName', 'count', 'slug'],
        properties: {
          displayName: { type: 'string' },
          count: { type: 'integer' },
          slug: nullableString,
        },
      },
    },
    accomplishments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['character', 'achievement'],
        properties: {
          character: { type: 'string' },
          achievement: { type: 'string' },
        },
      },
    },
    charUpdates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['character', 'field', 'value'],
        properties: {
          character: { type: 'string' },
          field: { type: 'string' },
          value: { type: 'string' },
        },
      },
    },
  },
};

const validationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['violations'],
  properties: {
    violations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'type', 'description', 'correction'],
        properties: {
          severity: { type: 'string', enum: ['minor', 'major'] },
          type: { type: 'string' },
          description: { type: 'string' },
          correction: { type: 'string' },
        },
      },
    },
  },
};

module.exports = {
  worldExtractionSchema,
  validationSchema,
};
