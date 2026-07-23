import { ZodError } from 'zod';

export function validate(schema, source = 'body') {
  return (req, res, next) => {
    try {
      req[source] = schema.parse(req[source]);
      return next();
    } catch (error) {
      if (!(error instanceof ZodError)) return next(error);
      return res.status(400).json({
        ok: false,
        message: 'Input tidak valid',
        fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
      });
    }
  };
}
