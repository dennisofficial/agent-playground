import Joi from 'joi';

export const engineEnvValidation = Joi.object({
  REDIS_URL: Joi.string().uri().required(),
});
