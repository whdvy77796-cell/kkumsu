// Temporary tombstone while the file is removed from the repository.
export default function handler(req,res){res.statusCode=404;res.setHeader('Cache-Control','no-store');res.end('Not found');}
